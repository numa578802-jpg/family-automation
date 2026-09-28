/**
 * 家族スケジュール自動登録スクリプト
 * ------------------------------------------------------------
 * 「家族スケジュール」フォルダに新しいPDF/写真が入ったら、
 * Gemini APIで内容を解析し、Googleカレンダーに自動登録します。
 *
 * ■ 事前準備
 * 1. スクリプトエディタ左メニュー「プロジェクトの設定」→
 *    「スクリプト プロパティ」に以下を追加:
 *      GEMINI_API_KEY   … Gemini APIキー(https://aistudio.google.com で取得)
 *      FOLDER_ID        … 「家族スケジュール」フォルダのID
 *      CALENDAR_ID      … 登録先カレンダーのID
 *      NOTIFY_EMAIL     … 一志の通知先メールアドレス(登録の確認・削除の両方が可能)
 *      KIKUMI_EMAIL     … きくみの通知先メールアドレス(登録の確認のみ可能。省略可)
 *    (フォルダID/カレンダーIDの調べ方は下部コメント参照)
 *
 * ■ 通知メールの権限について
 *    ・登録内容の「確認」: アップロードした本人 + 一志(NOTIFY_EMAIL) + きくみ(KIKUMI_EMAIL) の3人が可能
 *    ・登録内容の「削除」: アップロードした本人 + 一志(NOTIFY_EMAIL) の2人のみ可能
 *      (削除ボタンはこの2人宛のメールにしか含めません。ただしURLの仕組み上、
 *       このメールが第三者に転送された場合はその人も削除できてしまう点にご留意ください)
 * 2. setupTrigger() を一度だけ手動実行し、権限を許可する
 *    → 以降は15分おきに自動でcheckNewFiles()が実行されます
 * 3. 家族構成やスケジュール判定ルールが変わったら、下の
 *    FAMILY_PROFILE_ / CONTENT_RULES_ を直接書き換えてください。
 * ------------------------------------------------------------
 */

// ==== 国民の祝日一覧(内閣府公表、2026年4月〜2027年3月) ====
// 出典: https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
const JAPAN_HOLIDAYS_ = [
  '2026-04-29 昭和の日',
  '2026-05-03 憲法記念日',
  '2026-05-04 みどりの日',
  '2026-05-05 こどもの日',
  '2026-05-06 休日(振替休日)',
  '2026-07-20 海の日',
  '2026-08-11 山の日',
  '2026-09-21 敬老の日',
  '2026-09-22 休日(国民の休日)',
  '2026-09-23 秋分の日',
  '2026-10-12 スポーツの日',
  '2026-11-03 文化の日',
  '2026-11-23 勤労感謝の日',
  '2027-01-01 元日',
  '2027-01-11 成人の日',
  '2027-02-11 建国記念の日',
  '2027-02-23 天皇誕生日',
  '2027-03-21 春分の日',
  '2027-03-22 休日(振替休日)',
].join('\n');

// ==== 家族プロフィール・記号解釈ルール(NotebookLMでの運用ルールを移植) ====
const FAMILY_PROFILE_ = [
  '・みつき: 中学2年生。前林中学校。女子卓球部。習い事は英語(月曜18:10〜19:30)とお茶(木曜17:30〜18:30)。',
  '  習字はすでに辞めているため、書類に記載があっても出力に含めない。',
  '・ゆうき: 高校2年(2年7組)。刈谷高校。女子バドミントン部。夏期補習や模試の予定が多い。',
  '・一志(かずし): 父親。会社員および自治会役員。',
  '・きくみ: 母親。',
  '・ちあき: 成人済みの家族。',
].join('\n');

const CONTENT_RULES_ = [
  '・オレンジ色のハッチング(会社カレンダー)は会社休日を意味する。祝日でも白地の場合は稼働日として扱う。',
  '・丸印の中に×(手書きカレンダー)は、その日の予定が休み(キャンセル)になったことを意味するので、その予定は出力しない。',
  '・丸印(〇)の中に数字(学校予定表)はラーケーション取得可能日を示す。',
  '・同じ対象の予定表が複数ある場合、「改2」「訂正版」等の記載がある方を優先し、古い方の内容は出力しない。',
  '・自治会行事などで準備時間や予備日の注釈がある場合は、locationではなくdescriptionフィールドに記載する。',
  '・定期テスト(試験週間)、文化祭(代休の有無)、修学旅行、学校閉庁日なども漏らさず含める。',
  '・日本の国民の祝日(敬老の日、秋分の日など)は、Googleカレンダー上に別途「日本の祝日」として既に表示されているため、' +
  '「祝日で会社も休み」という当たり前の場合は出力しない。' +
  '「祝日にも関わらず一志の会社が稼働日である」という例外の場合のみ、' +
  'nameを"一志"、titleを"会社稼働日(祝日名)"という形式(例: "会社稼働日(敬老の日)")で1件だけ出力する。',
  '・1つのマス目に「(AM)◯◯ (PM)△△」のように午前・午後で異なる予定が書かれている場合、' +
  '1つのtitleに連結せず、"(AM)◯◯"と"(PM)△△"という2つの別々の要素に分けて出力する。',
  '・対象学年の限定: みつきは中学2年生、ゆうきは高校2年生を担当する。' +
  '書類内で「1年生限定」「3年生対象」のように明確に他学年向けと分かる記載がある行事は出力に含めない。' +
  '一方、学年の記載がない行事や、文化祭・体育祭・始業式・終業式のように学校全体・全学年が対象と分かる行事は、' +
  '除外せずそのまま出力する(nameにはみつきまたはゆうきのうち該当する学校に通う方を入れる)。',
  '・【リビングカレンダー(手書きの壁掛け月間カレンダー)について】書類が、印刷された月間カレンダーに' +
  '手書きの丸印や色付き文字で予定が書き込まれている形式の場合、以下のルールで対象者を判定してください。\n' +
  '  - 丸印の中に「一志」の文字がある書き込み → name="一志"\n' +
  '  - 丸印の中に「ゆ」の文字がある書き込み(多くの場合青文字) → name="ゆうき"\n' +
  '  - 丸印の中に「み」の文字がある書き込み、または日付の丸印のすぐ右側に「み」の文字がある書き込み → name="みつき"\n' +
  '  - 月曜日の日付が青色で丸囲みされている場合 → name="みつき", title="英語", ' +
  'start_time="18:10", end_time="19:30"(家族プロフィールの時間を使用する)\n' +
  '  - 木曜日の日付が青色で丸囲みされている場合 → name="みつき", title="お茶", ' +
  'start_time="17:30", end_time="18:30"(家族プロフィールの時間を使用する)\n' +
  '  - 水曜日に習字らしき書き込みがあっても無視する(みつきは習字をすでに辞めているため)\n' +
  '  - 上記のいずれの個人識別マークにも当てはまらない、単なる手書きの予定は、name="家族"として出力する' +
  '(家族全員向けの予定とみなす)。この場合のnameは"家族"という文字列を使ってよい。\n' +
  '  - 手書き文字の内容は、判読できる範囲でそのままtitleに記載してください。',
  '・【学習塾(英語)のカレンダーについて】書類の上部に「金　中3(18:15〜19:30)」のように、' +
  '曜日+学年+時刻を組み合わせた色丸の凡例が書かれている場合、これは家のリビングカレンダーではなく、' +
  '学習塾が発行する授業カレンダーです(上記のリビングカレンダーのルールとは別物として扱ってください。' +
  '凡例が無い手書きカレンダーは、引き続き上記のリビングカレンダーのルールで判定してください)。' +
  '色丸の意味は以下の通りです。\n' +
  '  - ピンクの丸(月曜) → name="みつき", title="英語(塾)", ' +
  'start_time="18:10", end_time="19:30"(家族プロフィールの時間を使用する)。みつきが在籍する中2のクラス。\n' +
  '  - 青・オレンジ・緑・紫の丸(月曜以外の曜日) → いずれも中1または中3など他学年のクラスのため、' +
  'みつきの予定には該当しない。出力しないでください。\n' +
  '  - 赤い下線+矢印で特定の日付(通常は月曜のピンクの丸の日)を指している「テスト対策」の書き込みは、' +
  'name="みつき", title="英語(テスト対策)"として、矢印の指す先の日付に1件だけ出力する。\n' +
  '  - 黒い四角枠で囲われた「テスト」の期間(複数日にまたがる場合が多い)は、具体的な授業ではなく' +
  '試験期間そのものの表示のため、出力しないでください。',
  '・【部活動計画表について】書類の上部に「部活動計画表」という見出しと、部活動名(例: 女子卓球部)・年月が' +
  '書かれている場合、これは部活動の活動予定表です。以下のルールで読み取ってください。\n' +
  '  - 「部活」列に丸印がある日**だけ**が活動日です。丸印が無い日は出力しないでください。\n' +
  '  - 「行事」列の内容は、通常は別の書類(学校スケジュール)で扱われるため無視してください。' +
  'ただし、大会・新人戦・練習試合など、部活動そのものに関連する行事名が書かれている場合は、' +
  '無視せず、titleに括弧書きで併記してください(例: "卓球部(新人戦)")。\n' +
  '  - 活動時間は「午前開始」「午前終了」「午後開始」「午後終了」の列を見てください。' +
  '午前の時間だけ埋まっていれば午前のみの活動、午後の時間だけ埋まっていれば午後のみの活動です。' +
  '両方とも埋まっている日は、午前の活動と午後の活動を、別々の2件の予定として出力してください' +
  '(1つの予定にまとめず、start_time/end_timeもそれぞれの時間帯だけにしてください)。\n' +
  '  - nameは、表の見出しに書かれている部活動名を家族プロフィールと照合して判定してください' +
  '(例: 「女子卓球部」→みつき)。',
  '・【部活動連絡アプリのスケジュール画面について】画面上部に学校名と部活動名(例: 「豊田市前林中学校 女子卓球部」)が表示され、' +
  '下部に「活動記録」「スケジュール」「チーム連絡」「目標管理」「メニュー」等のタブが並ぶ、' +
  'スマホアプリのスクリーンショットの場合、これは部活動連絡アプリの画面です' +
  '(上記の「部活動計画表」「練習予定表」とは別の書類として、以下のルールで読み取ってください)。\n' +
  '  - 黄色いラベル「部活」(主に平日についている) → name="みつき", title="卓球部(部活)", ' +
  'start_time="16:00", end_time="17:00"\n' +
  '  - 黄色いラベル「午前部」(主に土日についている) → name="みつき", title="卓球部(午前部)", ' +
  'start_time="08:00", end_time="11:00"\n' +
  '  - 青色または紫色のラベル「新人戦」「大会」「大会決勝」「練習試合」等の大会・試合系ラベル → ' +
  'name="みつき", title="卓球部(" + ラベルの文字 + ")"(例: "卓球部(新人戦)")、終日予定として出力する' +
  '(start_time・end_timeは空欄にする)。\n' +
  '  - ラベルが付いていない日は、活動が無い日なので出力しないでください。\n' +
  '  - 上記以外の色・文言のラベルが登場した場合は、ラベルの文字をそのままtitleに含め、' +
  '時間は不明として終日予定で出力してください。',
  '・【練習予定表(「R8 練習予定」のような日別の表形式)について】' +
  '書類の上部に「◯月の予定」という見出しと、部活動名(例: 女子バドミントン)が書かれ、' +
  '日付ごとに「区分」「場所」「学校行事」「備考」の列が並ぶ表の場合、以下のルールで読み取ってください。\n' +
  '  - 「学校行事」列の内容は、別の書類(学校スケジュール)ですでに扱われているため、完全に無視してください。\n' +
  '  - 「区分」列が「なし」の日は、活動が無い日なので出力しないでください。\n' +
  '  - 「区分」列が「9:00〜12:00(12:00〜13:00)」のように時間帯の後にカッコ書きの時間が続く場合、' +
  '最初の時間帯(例: 9:00〜12:00)を練習時間として使ってください。カッコ内の時間は片付けや会場予約の' +
  '終了時刻なので、予定のstart_time/end_timeには使わず、descriptionに' +
  '「会場は◯時まで予約」のように補足として記載してください。\n' +
  '  - 「区分」列の「業後」(授業後)は、17:00として扱ってください。' +
  '例: 「通常練習(業後〜17:15)」→ title="バドミントン部(通常練習)", start_time="17:00", end_time="17:15"。' +
  '「業後」を理由に時刻を空欄(終日予定)にしないでください。\n' +
  '  - 「区分」列に終わりの時刻が書かれていない場合(例: 「外練(業後〜)」)は、曜日で終わりの時刻を決めてください。' +
  '火曜日・水曜日は end_time="17:15"、それ以外の曜日(月曜日・木曜日・金曜日)は end_time="18:00"。' +
  '例: 木曜日の「外練(業後〜)」→ title="バドミントン部(外練)", start_time="17:00", end_time="18:00"。\n' +
  '  - 「場所」列や「区分」列に「2年生のみ」「1年のみ」のような学年の指定がある場合、' +
  '2年生が対象(「2年生のみ」など)の日は出力し、2年生が対象に含まれない日(「1年のみ」など)は出力しないでください。' +
  '学年の指定が無い日は、通常どおり出力してください。\n' +
  '  - 「区分」列が「西三河選手権(複)」「新人戦」のような大会名の場合、時刻の無い終日予定として、' +
  'titleに大会名を含めてください(例: "バドミントン部(西三河選手権-複)")。「場所」列の内容があれば' +
  'locationに入れてください(「場所、種目未定」のように未確定の場合はlocationを空にしてください)。\n' +
  '  - 「区分」列が「未定」の日は、時間・場所が未定であることが分かるように、' +
  'title="バドミントン部(未定)"、description="時間・場所未定"として終日予定で出力してください。\n' +
  '  - 「備考」列に「私大会の可能性あり」のような補足があれば、descriptionに追記してください。\n' +
  '  - nameは、表の見出しに書かれている部活動名を家族プロフィールと照合して判定してください' +
  '(例: 「女子バドミントン」→ゆうき)。',
  '・【コミュニティー(自治区)一般事業計画について】書類の見出しに「一般事業計画」「自治区」のような文言があり、' +
  '月日・事業内容・摘要の列を持つ年間行事表の場合、以下のルールで読み取ってください。\n' +
  '  - 表内の全ての行事は、一志さんの自治会役員としての予定として扱い、nameは"一志"にしてください' +
  '(不要なものは後で人が個別に削除する運用のため、判定に迷っても出力してください)。\n' +
  '  - titleには「事業内容」欄の文言をそのまま使い、「摘要」欄の内容はlocationに入れてください。\n' +
  '  - 【最優先】その行の「月日」欄に具体的な日付(例: 「10日(金)」)が明記されている場合は、' +
  '必ずその日付を使ってください。「事業内容」欄の中に「春の運動期間【6日〜15日】」のような' +
  '別の期間表記が書かれていても、それは補足情報として無視し(descriptionに記載する程度にとどめ)、' +
  '予定の日付を書き換えないでください。\n' +
  '  - 「◯月 中旬〜」「◯月 初旬〜」のように、その行の「月日」欄に具体的な日付が書かれていない場合**のみ**、' +
  '「事業内容」欄の文中に具体的な日付(例: 「赤い羽根募金(10/1〜12/31)」の「10/1」)があればそれを使い、' +
  '無ければその月の1日を仮の日付として使ってください。',
  '・【重要】みつきとゆうきの取り違え防止: 1つの書類は基本的にどちらか一方の学校の資料であり、' +
  'みつきとゆうきの両方が同じ書類に混在することは通常ありません。' +
  '書類内に「前林中学校」「刈谷高校」などの学校名が書かれていれば、それを最優先の判断材料にしてください。' +
  '学校名が無い場合も、「2年」という学年の数字だけで判断せず、必ず「中学校」か「高校」かの手がかり(校則、部活動名、' +
  '「高◯」「中◯」などの略称、制服、修学旅行の行き先、SSH(スーパーサイエンスハイスクール)行事のような高校特有の名称など)' +
  'を優先して判断してください。' +
  '書類が高校(刈谷高校)に関する内容だと判断できる場合は、学年に関わらずnameは"ゆうき"のみを使用し、' +
  'みつきを一切登場させないでください。逆に中学校(前林中学校)に関する内容の場合はnameは"みつき"のみを使用し、' +
  'ゆうきを一切登場させないでください。同じ日・同じ内容の予定を、みつきとゆうきの両方の名前で重複して出力することも絶対にしないでください。',
].join('\n');

// ==== 設定値の読み込み ====
function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    apiKey: props.getProperty('GEMINI_API_KEY'),
    folderId: props.getProperty('FOLDER_ID'),
    calendarId: props.getProperty('CALENDAR_ID'),
    // 任意設定: ファイルのアップロード者を判定するためのメールアドレス対応表
    // 例: "musume@gmail.com:みつき,musuko@gmail.com:ゆうき"
    familyEmailMap: props.getProperty('FAMILY_EMAIL_MAP') || '',
    // 任意設定: ファイル名に含まれるキーワード→家族の名前 の対応表(確定的な強制振り分け用)
    // 例: "みつき学校スケジュール:みつき,結気学校スケジュール:ゆうき"
    familyFilenameMap: props.getProperty('FAMILY_FILENAME_MAP') || '',
    // 通知メールの宛先(一志。未設定ならUtilities経由の自分のアカウント宛)
    notifyEmail: props.getProperty('NOTIFY_EMAIL') || Session.getActiveUser().getEmail(),
    // 通知メールの宛先(きくみ。登録内容の「確認」のみ可能で「削除」ボタンは表示しない)
    kikumiEmail: props.getProperty('KIKUMI_EMAIL') || '',
    // ウェブアプリのリンクを保護する秘密の合言葉(未設定なら通知メールにボタンを付けない)
    webAppToken: props.getProperty('WEBAPP_TOKEN') || '',
    // 「デプロイを管理」画面で確認した、正しいウェブアプリのURL(自動取得は不安定なため手動設定を優先する)
    webAppUrl: props.getProperty('WEBAPP_URL') || '',
  };
}

// ==== ファイルのアップロード者(所有者)から、対応する家族の名前を推定 ====
function guessUploaderName_(file, familyEmailMapStr) {
  if (!familyEmailMapStr) return '';
  try {
    const owner = file.getOwner();
    if (!owner) return '';
    const email = owner.getEmail();
    const pairs = familyEmailMapStr.split(',');
    for (let i = 0; i < pairs.length; i++) {
      const parts = pairs[i].split(':');
      if (parts.length === 2 && parts[0].trim() === email) {
        return parts[1].trim();
      }
    }
  } catch (e) {
    Logger.log('アップロード者の取得に失敗(スキップ): ' + e.message);
  }
  return '';
}

// ==== ファイルのアップロード者(所有者)のメールアドレスをそのまま取得(通知メールの宛先用) ====
function getUploaderEmail_(file) {
  try {
    const owner = file.getOwner();
    return owner ? owner.getEmail() : '';
  } catch (e) {
    Logger.log('アップロード者メールアドレスの取得に失敗(スキップ): ' + e.message);
    return '';
  }
}

// ==== ファイル名に含まれるキーワードから、強制的に対応する家族の名前を決定(確定的・Geminiの判断を上書きする) ====
function guessForcedNameFromFilename_(fileName, familyFilenameMapStr) {
  if (!familyFilenameMapStr) return '';
  const pairs = familyFilenameMapStr.split(',');
  for (let i = 0; i < pairs.length; i++) {
    const parts = pairs[i].split(':');
    if (parts.length === 2 && fileName.indexOf(parts[0].trim()) !== -1) {
      return parts[1].trim();
    }
  }
  return '';
}

// ==== forcedNameが指定されている場合:名前が空欄ならforcedNameを補完し、
//      forcedName以外の家族の名前になっている予定は誤抽出とみなして丸ごと除外する ====
function applyForcedName_(events, forcedName) {
  if (!forcedName) return events;
  const filtered = [];
  events.forEach(function (ev) {
    if (!ev.name || ev.name === forcedName) {
      ev.name = forcedName;
      filtered.push(ev);
    } else {
      // このファイルは forcedName の書類のはずなのに、別の家族の名前になっている
      // → 誤抽出とみなし、書き換えずにこの予定ごと除外する
      Logger.log(
        'ファイル名から確定した対象(' + forcedName + ')と異なる名前(' + ev.name + ')の予定を除外: ' + ev.title
      );
    }
  });
  return filtered;
}


// ==== トリガー設定(最初に1回だけ手動実行) ====
function setupTrigger() {
  // 既存の同名トリガーを一旦削除(重複防止)
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkNewFiles') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('checkNewFiles')
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log('トリガーを設定しました。15分おきにcheckNewFiles()が実行されます。');
}

// ==== 1回の実行で登録する予定の最大件数(タイムアウト防止) ====
const BATCH_SIZE_ = 80;

// ==== 1回の実行の中で、時間の許す限り続けて処理するための目安(GASの実行上限は6分) ====
// ・新しいファイルの抽出(Gemini解析)を始めてよいのは、実行開始からこの時間まで
//   (Geminiの混雑時は自動リトライで最大2分程度かかるため、余裕を持たせている)
const NEW_FILE_START_LIMIT_MS_ = 120 * 1000;
// ・登録待ち(ペンディング)の次の80件の登録を始めてよいのは、実行開始からこの時間まで
const BATCH_START_LIMIT_MS_ = 210 * 1000;

// ==== メイン処理:登録待ちの続き → 新規ファイル の順に、時間の許す限り続けて処理する ====
// 15分おきの定期トリガーのほか、LINEで受信した直後や、処理しきれなかったときの
// 「1分後の続き実行」(runFamilyScheduleFollowup_)からも呼ばれる。
function checkNewFiles() {
  const config = getConfig_();
  if (!config.apiKey || !config.folderId || !config.calendarId) {
    Logger.log('スクリプトプロパティ(GEMINI_API_KEY / FOLDER_ID / CALENDAR_ID)が未設定です。');
    return;
  }

  // 同時に2つの取り込み処理が動かないようにする(定期実行と続き実行が重なった場合など)
  // (取り込めなかった場合も、ファイルはフォルダに残ったままなので消えることはなく、1分後に再試行する)
  const lease = acquireFamilyScheduleLease_();
  if (lease !== 'acquired') {
    Logger.log(lease === 'lock_timeout'
      ? '排他ロックを30秒待っても取得できなかった(天気配信の処理と重なった可能性)ため、1分後に再試行します。'
      : '別の取り込み処理が実行中のため、1分後に再試行します。');
    requestFamilyScheduleRunSoon_(lease === 'lock_timeout' ? 'ロック取得待ちのタイムアウト' : '実行中の処理と重なったため');
    return;
  }

  try {
    const hasMoreWork = processFilesWithinTimeLimit_(config);
    if (hasMoreWork) {
      requestFamilyScheduleRunSoon_('時間内に処理しきれなかった分の続き');
    }
  } finally {
    releaseFamilyScheduleLease_();
  }
}

// ==== 時間の許す限りファイルを処理する。続きが残っていれば true を返す ====
function processFilesWithinTimeLimit_(config) {
  const startedAt = Date.now();
  const folder = DriveApp.getFolderById(config.folderId);
  const processedFolder = getOrCreateProcessedFolder_(folder);
  const pendingFolder = getOrCreatePendingFolder_(folder);
  const failedFileIds = {}; // この実行中にエラーになったファイル(同じ実行内で何度も再試行しない)
  const geminiState = loadGeminiState_(); // Geminiの本日の利用状況(モデルごとの呼び出し回数・上限到達・ファイルごとの挑戦回数)
  cleanupOldBusyRetryProps_();

  while (true) {
    const elapsed = Date.now() - startedAt;

    // ① 登録待ち(ペンディング)があれば、その続きを登録
    const pendingFile = findPendingJsonFile_(pendingFolder);
    if (pendingFile) {
      if (elapsed > BATCH_START_LIMIT_MS_) return true;
      let progress;
      try {
        progress = processPendingBatch_(pendingFile, config.calendarId, processedFolder);
      } catch (e) {
        Logger.log('登録待ち分の登録でエラー(次回の定期実行で再試行します): ' + e.message);
        return false;
      }
      if (progress.successCount === 0 && progress.remainingCount > 0) {
        // 1件も登録できない(カレンダーの1日の上限など)。続き実行を連発せず、次回の定期実行に任せる
        Logger.log('登録が1件も進まなかったため、続きは次回の定期実行に任せます。');
        return false;
      }
      continue;
    }

    // ② 登録待ちが無ければ、未処理の新規ファイルを1件抽出
    // すべての読み取りモデルが本日の上限に達している間は、Geminiを一切呼ばない(リセット後に自動で再開する)
    if (allGeminiModelsExhausted_(geminiState)) {
      if (findNextScheduleFile_(folder, failedFileIds, geminiState)) {
        enterGeminiWaitMode_(geminiState, folder);
        Logger.log('すべての読み取りモデルが本日の上限に達しているため、新しいファイルの読み取りはリセット後まで待ちます。');
      }
      return false;
    }
    const file = findNextScheduleFile_(folder, failedFileIds, geminiState);
    if (!file) return false; // すべて処理しきった(本日の挑戦回数の上限に達したファイルは除く)
    if (elapsed > NEW_FILE_START_LIMIT_MS_) return true;

    const result = extractScheduleFile_(file, config, folder, processedFolder, pendingFolder, startedAt, geminiState);
    if (result === 'waiting') return false;
    if (result !== 'ok') failedFileIds[file.getId()] = true;
  }
}

// ==== 「作業中」フォルダから、名前が「.pending.json」で終わる登録待ちデータを1件返す(無ければ null) ====
// (無関係なテキストファイルが紛れ込んでいても、誤って内部データとして読み込まないようにするため。9/17の不具合対応)
function findPendingJsonFile_(pendingFolder) {
  const pendingFilesIter = pendingFolder.getFilesByType(MimeType.PLAIN_TEXT);
  while (pendingFilesIter.hasNext()) {
    const candidate = pendingFilesIter.next();
    if (candidate.getName().indexOf('.pending.json') !== -1) {
      return candidate;
    }
    Logger.log('「作業中」フォルダに想定外のファイルがあります(無視します): ' + candidate.getName());
  }
  return null;
}

// ==== フォルダ直下の未処理ファイル(PDF・画像)を1件返す(無ければ null) ====
// 本日の挑戦回数の上限(FILE_DAILY_ATTEMPT_MAX_)に達したファイルは、リセット後まで対象にしない
function findNextScheduleFile_(folder, failedFileIds, geminiState) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const mime = file.getMimeType();
    if (mime !== MimeType.PDF && mime.indexOf('image/') !== 0) continue;
    if (failedFileIds[file.getId()]) continue;
    if (geminiState && (geminiState.fileAttempts[file.getId()] || 0) >= FILE_DAILY_ATTEMPT_MAX_) continue;
    return file;
  }
  return null;
}

// ==== 1ファイルを抽出して登録待ち(ペンディング)にする ====
// 戻り値: 'ok'(成功) / 'failed'(失敗。ファイルは残し後で再挑戦) / 'waiting'(全モデルが本日の上限に達した)
function extractScheduleFile_(file, config, folder, processedFolder, pendingFolder, startedAt, geminiState) {
  const fileId = file.getId();
  // このファイルへの本日の挑戦回数を数える(失敗した呼び出しも無料枠の回数に数えられるため、1日の挑戦回数に上限を設ける)
  const attempts = (geminiState.fileAttempts[fileId] || 0) + 1;
  geminiState.fileAttempts[fileId] = attempts;
  saveGeminiState_(geminiState);
  try {
    Logger.log('処理開始: ' + file.getName());
    const uploader = resolveUploader_(file, config);
    if (uploader.name) {
      Logger.log('アップロード者ヒント: ' + uploader.name + (uploader.viaLine ? '(LINE経由)' : ''));
    }
    if (uploader.email) {
      Logger.log('アップロード者のメールアドレス: ' + uploader.email);
    }
    const extracted = extractWithModelFallback_(file, config, uploader.name, geminiState);
    const rawExtractedEvents = extracted.events;
    Logger.log('読み取りモデル: ' + extracted.model.label + '(このファイルへの本日の挑戦 ' + attempts + '/' + FILE_DAILY_ATTEMPT_MAX_ + '回目)');
    const forcedName = guessForcedNameFromFilename_(file.getName(), config.familyFilenameMap);
    if (forcedName) {
      Logger.log('ファイル名から強制的に名前を確定: ' + forcedName);
    }
    const forcedEvents = applyForcedName_(rawExtractedEvents, forcedName);
    const events = mergeConsecutiveSameTitleEvents_(forcedEvents);
    if (events && events.length > 0) {
      Logger.log(
        rawExtractedEvents.length + '件を抽出し、連続日をまとめて' + events.length + '件にしました。登録を開始します: ' + file.getName()
      );
      const pendingData = {
        sourceFileId: file.getId(),
        sourceFileName: file.getName(),
        remainingEvents: events,
        uploaderEmail: uploader.email,
        extractModel: { label: extracted.model.label, lite: extracted.model.lite },
      };
      const pendingFile = pendingFolder.createFile(
        file.getName() + '.pending.json',
        JSON.stringify(pendingData),
        MimeType.PLAIN_TEXT
      );
      // 時間に余裕があれば、抽出できたその場で1バッチ目を登録(無ければ次のループ/続き実行で登録)
      if (Date.now() - startedAt <= BATCH_START_LIMIT_MS_) {
        processPendingBatch_(pendingFile, config.calendarId, processedFolder);
      }
    } else {
      Logger.log('予定を抽出できませんでした: ' + file.getName());
      writeProcessLog_(folder, file.getName(), [], null, extracted.model.label);
      file.moveTo(processedFolder);
    }
    delete geminiState.fileAttempts[fileId];
    saveGeminiState_(geminiState);
    logGeminiCallSummary_(geminiState);
    return 'ok';
  } catch (e) {
    Logger.log('エラー(' + file.getName() + '): ' + e.message);
    logGeminiCallSummary_(geminiState);
    if (e.geminiKind === 'allExhausted') {
      // ファイルのせいではないので、挑戦回数には数えない
      geminiState.fileAttempts[fileId] = attempts - 1;
      saveGeminiState_(geminiState);
      enterGeminiWaitMode_(geminiState, folder);
      return 'waiting';
    }
    writeProcessLog_(folder, file.getName(), [], e.message);
    // エラーが出たファイルは残しておき、後で再挑戦する(本日の挑戦回数の上限まで)
    if (attempts >= FILE_DAILY_ATTEMPT_MAX_) {
      Logger.log('このファイルは本日の挑戦回数の上限(' + FILE_DAILY_ATTEMPT_MAX_ + '回)に達したため、リセット後に再挑戦します: ' + file.getName());
    } else if (e.geminiKind === 'busy') {
      // Googleの一時的な混雑なら、15分おきの定期実行を待たずに5分後に再挑戦する
      requestFamilyScheduleRunSoon_('Gemini混雑のため再試行(' + attempts + '/' + FILE_DAILY_ATTEMPT_MAX_ + '回目の挑戦が失敗)', GEMINI_BUSY_RETRY_DELAY_MS_);
    }
    return 'failed';
  }
}

// ==== 読み取りに使うGeminiモデル(1日の上限に達したら、この順に自動で切り替える) ====
// 無料枠の1日の上限は「プロジェクトごと・モデルごと」に別々に数えられる。
// (2026-09-28時点の上限: 3.5 Flash 20回 / 3.6 Flash 20回 / 3.5 Flash Lite 500回。日本時間16:00(冬時間は17:00)にリセット)
const GEMINI_EXTRACT_MODELS_ = [
  { id: 'gemini-3.5-flash', label: '3.5 Flash', lite: false }, // 読み取りルールはこのモデルで調整してきた(精度重視)
  { id: 'gemini-3.6-flash', label: '3.6 Flash', lite: false },
  { id: 'gemini-3.5-flash-lite', label: '3.5 Flash Lite', lite: true }, // 精度が下がる可能性があるため、通知メールで明示する
];
// 1ファイルへの1日の挑戦回数の上限(1回の挑戦でGeminiを最大2回呼ぶので、1ファイル最大6回)
const FILE_DAILY_ATTEMPT_MAX_ = 3;
// Googleの一時的な混雑で失敗したときの、次の挑戦までの待ち時間
const GEMINI_BUSY_RETRY_DELAY_MS_ = 5 * 60 * 1000;
// 本日の利用状況を保存するスクリプトプロパティ
const GEMINI_STATE_PROP_ = 'FAMILY_SCHEDULE_GEMINI_STATE';
// 全モデルが上限に達したとき、リセット時刻の何分後に取り込みを再開するか
const GEMINI_RESET_BUFFER_MS_ = 5 * 60 * 1000;
// リセット後の再開を予約したことを記録するスクリプトプロパティ(二重予約の防止)
const GEMINI_RESUME_PROP_ = 'FAMILY_SCHEDULE_RESUME_AT';

// ==== 無料枠の「1日」を表す日付(太平洋時間の日付。日本時間16:00/17:00に切り替わる) ====
function geminiQuotaDay_(date) {
  return Utilities.formatDate(date || new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

// ==== 次のリセット時刻(太平洋時間の翌日0時) ====
function nextGeminiResetTime_() {
  const now = new Date();
  const todayPt = geminiQuotaDay_(now);
  const z = Utilities.formatDate(now, 'America/Los_Angeles', 'Z'); // 例: -0700
  const offset = z.slice(0, 3) + ':' + z.slice(3);
  const midnightToday = new Date(todayPt + 'T00:00:00' + offset);
  return new Date(midnightToday.getTime() + 24 * 60 * 60 * 1000);
}

// ==== 本日の利用状況を読み込む(日付が変わっていたら、まっさらな状態から始める) ====
function loadGeminiState_() {
  const today = geminiQuotaDay_();
  let state = null;
  try {
    state = JSON.parse(PropertiesService.getScriptProperties().getProperty(GEMINI_STATE_PROP_) || 'null');
  } catch (e) {
    state = null;
  }
  if (!state || state.day !== today) {
    state = { day: today, calls: {}, exhausted: {}, fileAttempts: {}, waitUntil: 0, waitNotified: false };
  }
  return state;
}

function saveGeminiState_(state) {
  PropertiesService.getScriptProperties().setProperty(GEMINI_STATE_PROP_, JSON.stringify(state));
}

// ==== 読み取りモデルがすべて本日の上限に達しているか ====
function allGeminiModelsExhausted_(state) {
  return GEMINI_EXTRACT_MODELS_.every(function (m) { return state.exhausted[m.id]; });
}

// ==== LINE受付(ScheduleIntake_Line.gs)から呼ぶ:全モデルが上限に達していれば再開予定時刻を、そうでなければ null を返す ====
function getFamilyScheduleQuotaWait_() {
  const state = loadGeminiState_();
  if (!allGeminiModelsExhausted_(state)) return null;
  return new Date(state.waitUntil || (nextGeminiResetTime_().getTime() + GEMINI_RESET_BUFFER_MS_));
}

// ==== モデルを順に試して読み取る。1日の上限に達したモデルは飛ばして次のモデルへ ====
function extractWithModelFallback_(file, config, uploaderName, state) {
  for (let i = 0; i < GEMINI_EXTRACT_MODELS_.length; i++) {
    const m = GEMINI_EXTRACT_MODELS_[i];
    if (state.exhausted[m.id]) continue;
    try {
      const events = callGeminiApi_(file, config.apiKey, uploaderName, m.id, function (modelId) {
        state.calls[modelId] = (state.calls[modelId] || 0) + 1;
      });
      saveGeminiState_(state);
      return { events: events, model: m };
    } catch (e) {
      saveGeminiState_(state);
      if (e.geminiKind === 'daily') {
        state.exhausted[m.id] = true;
        saveGeminiState_(state);
        const nextModel = GEMINI_EXTRACT_MODELS_.slice(i + 1).filter(function (x) { return !state.exhausted[x.id]; })[0];
        Logger.log('Gemini ' + m.label + ' が本日の上限に達しました。' +
          (nextModel ? '次のモデル(' + nextModel.label + ')に切り替えます。' : '使える読み取りモデルが残っていません。'));
        continue;
      }
      throw e;
    }
  }
  const err = new Error('すべての読み取りモデルが本日の上限に達しています');
  err.geminiKind = 'allExhausted';
  throw err;
}

// ==== 全モデルが上限に達したときの待機:リセット後の再開を予約し、一志に1回だけ知らせる ====
function enterGeminiWaitMode_(state, folder) {
  const resumeAt = nextGeminiResetTime_().getTime() + GEMINI_RESET_BUFFER_MS_;
  state.waitUntil = resumeAt;
  saveGeminiState_(state);
  scheduleResumeAfterReset_(resumeAt);
  if (!state.waitNotified) {
    state.waitNotified = true;
    saveGeminiState_(state);
    try {
      sendQuotaWaitEmail_(folder, resumeAt, state);
    } catch (e) {
      Logger.log('上限到達のお知らせメールの送信でエラー: ' + e.message);
    }
  }
}

function scheduleResumeAfterReset_(resumeAt) {
  const props = PropertiesService.getScriptProperties();
  if (Number(props.getProperty(GEMINI_RESUME_PROP_) || 0) === resumeAt) return; // 予約済み
  ScriptApp.newTrigger('runFamilyScheduleAfterReset_').timeBased().at(new Date(resumeAt)).create();
  props.setProperty(GEMINI_RESUME_PROP_, String(resumeAt));
  Logger.log('リセット後の取り込み再開を予約しました: ' + Utilities.formatDate(new Date(resumeAt), 'Asia/Tokyo', 'M月d日 H:mm'));
}

// ==== scheduleResumeAfterReset_ が作った使い捨てトリガーから呼ばれる ====
function runFamilyScheduleAfterReset_(e) {
  if (e && e.triggerUid) {
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getUniqueId() === e.triggerUid) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
  }
  PropertiesService.getScriptProperties().deleteProperty(GEMINI_RESUME_PROP_);
  checkNewFiles();
}

// ==== 全モデルが上限に達したことを一志に知らせる(待機に入ったときに1回だけ) ====
function sendQuotaWaitEmail_(folder, resumeAt, state) {
  const config = getConfig_();
  if (!config.notifyEmail) return;
  let waitingCount = 0;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const mime = files.next().getMimeType();
    if (mime === MimeType.PDF || mime.indexOf('image/') === 0) waitingCount++;
  }
  const resumeText = Utilities.formatDate(new Date(resumeAt), 'Asia/Tokyo', 'M月d日 H:mm');
  MailApp.sendEmail({
    to: config.notifyEmail,
    subject: '【家族スケジュール自動登録】本日の読み取り回数の上限に達しました(' + resumeText + '以降に自動で再開)',
    htmlBody:
      '<p>Geminiの読み取りモデル(' + GEMINI_EXTRACT_MODELS_.map(function (m) { return m.label; }).join('・') +
      ')が、すべて本日の無料枠の上限に達しました。</p>' +
      '<p>未処理のファイルは ' + waitingCount + ' 件です。<b>' + resumeText + ' 以降に自動で取り込みを再開します。</b>' +
      'ファイルはそのままで大丈夫です(別のフォルダへ移す必要はありません)。</p>' +
      '<p>本日の読み取りでの呼び出し回数: ' + formatGeminiCallSummary_(state) + '</p>',
  });
}

// ==== 本日のモデルごとの呼び出し回数(読み取り分。セルフチェック分は含まない) ====
function formatGeminiCallSummary_(state) {
  return GEMINI_EXTRACT_MODELS_.map(function (m) {
    return m.label + ' ' + (state.calls[m.id] || 0) + '回' + (state.exhausted[m.id] ? '(上限到達)' : '');
  }).join(' / ');
}

function logGeminiCallSummary_(state) {
  Logger.log('本日のGemini呼び出し回数(太平洋時間 ' + state.day + '、読み取り分): ' + formatGeminiCallSummary_(state));
}

// ==== 旧方式(9/27版)の再試行カウンターが残っていれば削除する ====
function cleanupOldBusyRetryProps_() {
  const props = PropertiesService.getScriptProperties();
  props.getKeys().forEach(function (key) {
    if (key.indexOf('FAMILY_SCHEDULE_BUSY_RETRY_') === 0) props.deleteProperty(key);
  });
}

// ==== アップロード者(誰の分か)を判定する ====
// LINE経由で保存されたファイルは、説明欄の「line_uploader=◯◯」(受信したチャネルの持ち主)を優先する。
// それ以外(Driveへの直接アップロード)は従来どおりDriveのオーナーで判定する。
function resolveUploader_(file, config) {
  let description = '';
  try {
    description = file.getDescription() || '';
  } catch (e) {
    description = '';
  }
  const match = /(?:^|\n)line_uploader=([^\n]+)/.exec(description);
  if (match) {
    const name = match[1].trim();
    return { name: name, email: emailForFamilyName_(name, config), viaLine: true };
  }
  return {
    name: guessUploaderName_(file, config.familyEmailMap),
    email: getUploaderEmail_(file),
    viaLine: false,
  };
}

// ==== 家族の名前 → メールアドレス(FAMILY_EMAIL_MAP の「メール:名前」を逆引き) ====
function emailForFamilyName_(name, config) {
  const pairs = (config.familyEmailMap || '').split(',');
  for (let i = 0; i < pairs.length; i++) {
    const parts = pairs[i].split(':');
    if (parts.length === 2 && parts[1].trim() === name) {
      return parts[0].trim();
    }
  }
  if (name === '一志') return config.notifyEmail || '';
  if (name === 'きくみ') return config.kikumiEmail || '';
  Logger.log('FAMILY_EMAIL_MAPに「' + name + '」のメールアドレスが見つかりません(通知は一志・きくみのみに届きます)。');
  return '';
}

// ==== 取り込み処理の「実行中」目印(リース) ====
// LockService(スクリプトロック)はプロジェクト全体で1つしかなく、天気配信の2重送信対策が使っているため、
// 取り込み処理(最大数分)の間ずっと握り続けると天気配信の通知が見送られてしまう。
// そこで、ロックは「目印の確認・書き込み」の一瞬だけ使い、実行中かどうかはスクリプトプロパティの
// 有効期限付きの目印で管理する(万一実行が強制終了しても、期限が過ぎれば自動的に無効になる)。
const FAMILY_SCHEDULE_LEASE_PROP_ = 'FAMILY_SCHEDULE_RUNNING_UNTIL';
const FAMILY_SCHEDULE_LEASE_MS_ = 7 * 60 * 1000; // GASの実行上限(6分)より少し長く

// 戻り値: 'acquired'(取得できた) / 'busy'(別の取り込み処理が実行中) / 'lock_timeout'(ロック待ちで時間切れ)
function acquireFamilyScheduleLease_() {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(30 * 1000);
  } catch (e) {
    locked = false;
  }
  if (!locked) return 'lock_timeout';
  try {
    const props = PropertiesService.getScriptProperties();
    const runningUntil = Number(props.getProperty(FAMILY_SCHEDULE_LEASE_PROP_) || 0);
    if (runningUntil > Date.now()) return 'busy';
    props.setProperty(FAMILY_SCHEDULE_LEASE_PROP_, String(Date.now() + FAMILY_SCHEDULE_LEASE_MS_));
    return 'acquired';
  } finally {
    lock.releaseLock();
  }
}

function releaseFamilyScheduleLease_() {
  PropertiesService.getScriptProperties().deleteProperty(FAMILY_SCHEDULE_LEASE_PROP_);
}

// ==== 約1分後に取り込み処理を1回実行するよう予約する(すでに予約済みなら何もしない) ====
// LINEで受信した直後と、時間内に処理しきれなかったときに使う。予約は常に1つまでにして、
// トリガーの作りすぎ(GASの上限は1プロジェクト20個)を防ぐ。
const FAMILY_SCHEDULE_FOLLOWUP_PROP_ = 'FAMILY_SCHEDULE_FOLLOWUP_AT';
const FAMILY_SCHEDULE_FOLLOWUP_DELAY_MS_ = 60 * 1000;

// delayMs を省略した場合は約1分後(FAMILY_SCHEDULE_FOLLOWUP_DELAY_MS_)。
function requestFamilyScheduleRunSoon_(reason, delayMs) {
  const delay = delayMs || FAMILY_SCHEDULE_FOLLOWUP_DELAY_MS_;
  const props = PropertiesService.getScriptProperties();
  const scheduledAt = Number(props.getProperty(FAMILY_SCHEDULE_FOLLOWUP_PROP_) || 0);
  // 予約済み(かつ予定時刻から5分以上過ぎた古い目印ではない)なら、新たに予約しない
  if (scheduledAt && scheduledAt > Date.now() - 5 * 60 * 1000) {
    Logger.log('取り込み実行はすでに予約済みです(' + reason + ')。');
    return;
  }
  props.setProperty(FAMILY_SCHEDULE_FOLLOWUP_PROP_, String(Date.now() + delay));
  ScriptApp.newTrigger('runFamilyScheduleFollowup_').timeBased().after(delay).create();
  Logger.log('約' + Math.round(delay / 60000) + '分後に取り込み処理を予約しました(' + reason + ')。');
}

// ==== requestFamilyScheduleRunSoon_ が作った使い捨てトリガーから呼ばれる ====
function runFamilyScheduleFollowup_(e) {
  if (e && e.triggerUid) {
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getUniqueId() === e.triggerUid) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
  }
  PropertiesService.getScriptProperties().deleteProperty(FAMILY_SCHEDULE_FOLLOWUP_PROP_);
  checkNewFiles();
}

// ==== ペンディング(登録待ち)分を最大BATCH_SIZE_件だけ登録し、残りを保存 ====
function processPendingBatch_(pendingFile, calendarId, processedFolder) {
  let data;
  try {
    data = JSON.parse(pendingFile.getBlob().getDataAsString('UTF-8'));
  } catch (e) {
    // 中身が壊れている(JSONとして読めない)場合は、その後の全トリガーを巻き込んで
    // 止まり続けることのないよう、このファイルだけを隔離して処理を終える
    Logger.log(
      '「作業中」フォルダのファイルが壊れているため隔離します: ' + pendingFile.getName() +
      ' / ' + e.message
    );
    try {
      pendingFile.setName('(破損)' + pendingFile.getName());
      pendingFile.moveTo(processedFolder);
    } catch (e2) {
      Logger.log('壊れたファイルの隔離にも失敗しました: ' + e2.message);
    }
    // 隔離済み。登録の進み具合としては「残り0件」を返し、呼び出し元の連続処理は次へ進める
    return { successCount: 0, remainingCount: 0, quarantined: true };
  }
  const remaining = data.remainingEvents;

  const batch = remaining.slice(0, BATCH_SIZE_);

  // 既存の予定と同じためスキップした分は、セルフチェックとメールで「見落とし」と誤解されないよう記録して引き継ぐ
  const skippedDuplicates = (data.skippedDuplicates || []).slice();
  const successCount = registerEvents_(batch, calendarId, data.sourceFileName, skippedDuplicates);
  // 実際に成功した件数分だけ「登録済み」として切り離す(途中でエラーが出ても重複しないように)
  const rest = remaining.slice(successCount);

  Logger.log(
    successCount + '件登録しました(残り' + rest.length + '件): ' + data.sourceFileName
  );

  if (rest.length === 0) {
    // 全件登録完了。元ファイルを処理済みへ移動し、ペンディングファイルを削除
    let sourceFile = null;
    try {
      sourceFile = DriveApp.getFileById(data.sourceFileId);
      sourceFile.moveTo(processedFolder);
    } catch (e) {
      Logger.log('元ファイルの移動でエラー(すでに移動済みの可能性): ' + e.message);
    }
    writeProcessLog_(processedFolder.getParents().next(), data.sourceFileName, data.remainingEvents, null,
      data.extractModel ? data.extractModel.label : '');
    pendingFile.setTrashed(true);
    Logger.log('全件登録完了: ' + data.sourceFileName);

    // セルフチェック + 通知メール送信は、抽出・登録と同じ実行内で行うと
    // 合計実行時間が6分の上限を超えてスクリプトごと強制終了する恐れがあるため、
    // 別トリガーの新しい実行(新しい6分の持ち時間)に切り出す
    try {
      scheduleNotification_(data.sourceFileId, data.sourceFileName, data.uploaderEmail, skippedDuplicates, data.extractModel || null);
    } catch (e) {
      Logger.log('通知メールの予約でエラー(処理自体は完了しています): ' + e.message);
    }
  } else {
    // 残りを保存して次回に持ち越し
    pendingFile.setContent(
      JSON.stringify({
        sourceFileId: data.sourceFileId,
        sourceFileName: data.sourceFileName,
        remainingEvents: rest,
        uploaderEmail: data.uploaderEmail,
        skippedDuplicates: skippedDuplicates,
        extractModel: data.extractModel || null,
      })
    );
  }
  return { successCount: successCount, remainingCount: rest.length };
}

// ==== セルフチェック+通知メール送信を、少し後に別実行で行うよう予約する ====
// (抽出・登録と同じ実行内で行うと6分の実行時間上限に達する恐れがあるため分離)
function scheduleNotification_(fileId, fileName, uploaderEmail, skippedDuplicates, extractModel) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(
    'PENDING_NOTIFY_' + fileId,
    JSON.stringify({
      fileId: fileId,
      fileName: fileName,
      uploaderEmail: uploaderEmail,
      skippedDuplicates: skippedDuplicates || [],
      extractModel: extractModel || null,
    })
  );
  // 10秒後に一度だけ実行されるトリガーを作成(新しい実行=新しい6分の持ち時間になる)
  ScriptApp.newTrigger('runScheduledNotifications_').timeBased().after(10 * 1000).create();
}

// ==== scheduleNotification_で予約された通知を、新しい実行の中で処理する ====
// (10分おきなどの定期トリガーではなく、scheduleNotification_が作った使い捨てトリガーからのみ呼ばれる)
function runScheduledNotifications_(e) {
  // 自分自身を呼び出したトリガーは、多重実行を防ぐため実行後すぐ削除する
  if (e && e.triggerUid) {
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getUniqueId() === e.triggerUid) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
  }

  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  const config = getConfig_();

  Object.keys(allProps).forEach(function (key) {
    if (key.indexOf('PENDING_NOTIFY_') !== 0) return;
    const data = JSON.parse(allProps[key]);
    // 二重送信を防ぐため、処理対象として取り出した時点で先に削除しておく
    props.deleteProperty(key);

    try {
      let sourceFile = null;
      try {
        sourceFile = DriveApp.getFileById(data.fileId);
      } catch (e2) {
        sourceFile = null; // 処理済みフォルダへの移動後でも取得自体は可能なはずだが念のため
      }
      const registeredLines = previewBySourceFile_(data.fileName, config.calendarId);
      const skippedLines = data.skippedDuplicates || [];
      let checkReport = '(セルフチェックは実行されませんでした)';
      if (sourceFile && config.apiKey) {
        checkReport = performSelfCheck_(sourceFile, config.apiKey, registeredLines, skippedLines);
      }
      sendNotificationEmail_(config, data.fileName, registeredLines.length, checkReport, data.uploaderEmail, skippedLines, data.extractModel || null);
    } catch (err) {
      Logger.log('遅延通知の処理でエラー: ' + err.message + ' (対象: ' + data.fileName + ')');
    }
  });
}

// ==== 「作業中」(ペンディング)サブフォルダを取得(なければ作成) ====
function getOrCreatePendingFolder_(parentFolder) {
  const name = '作業中';
  const existing = parentFolder.getFoldersByName(name);
  if (existing.hasNext()) {
    return existing.next();
  }
  return parentFolder.createFolder(name);
}

// ==== 処理ログをテキストファイルに追記(いつ・どのファイルから・何件・どんな予定を登録したか) ====
// modelLabel(省略可)を渡すと、読み取りに使ったGeminiモデルも記録する
function writeProcessLog_(parentFolder, fileName, events, errorMessage, modelLabel) {
  const logFolder = getOrCreateLogFolder_(parentFolder);
  const logFileName = '処理ログ.txt';

  const now = new Date();
  const timestamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  let lines = [];
  lines.push('====================================');
  lines.push('[' + timestamp + '] ファイル: ' + fileName);
  if (modelLabel) {
    lines.push('読み取りモデル: ' + modelLabel);
  }

  if (errorMessage) {
    lines.push('結果: エラー - ' + errorMessage);
  } else if (events.length === 0) {
    lines.push('結果: 予定を抽出できず(0件)');
  } else {
    lines.push('結果: ' + events.length + '件登録');
    events.forEach(function (ev) {
      const nameLabel = ev.name || '要確認';
      lines.push('  ・[' + nameLabel + '] ' + ev.date + ' ' + (ev.start_time || '終日') + ' ' + ev.title);
    });
  }
  const entryText = lines.join('\n');

  const existing = logFolder.getFilesByName(logFileName);
  if (existing.hasNext()) {
    const file = existing.next();
    const current = file.getBlob().getDataAsString('UTF-8');
    file.setContent(current + '\n' + entryText);
  } else {
    logFolder.createFile(logFileName, entryText, MimeType.PLAIN_TEXT);
  }
}

// ==== 「ログ」サブフォルダを取得(なければ作成) ====
function getOrCreateLogFolder_(parentFolder) {
  const name = 'ログ';
  const existing = parentFolder.getFoldersByName(name);
  if (existing.hasNext()) {
    return existing.next();
  }
  return parentFolder.createFolder(name);
}

// ==== 「処理済み」サブフォルダを取得(なければ作成) ====
function getOrCreateProcessedFolder_(parentFolder) {
  const name = '処理済み';
  const existing = parentFolder.getFoldersByName(name);
  if (existing.hasNext()) {
    return existing.next();
  }
  return parentFolder.createFolder(name);
}

// ==== Gemini APIを呼び出してJSON形式で予定を抽出 ====
// modelId: 使うモデル(省略時は gemini-3.5-flash)。onCall(省略可): APIを1回呼ぶたびに呼ばれる(呼び出し回数の記録用)
// 失敗時に投げるエラーには geminiKind を付ける: 'busy'(一時的な混雑) / 'daily'(そのモデルの1日の上限) / 'other'
function callGeminiApi_(file, apiKey, uploaderHint, modelId, onCall) {
  const model = modelId || 'gemini-3.5-flash'; // オレンジ日付の見落とし防止のため精度重視モデルに変更
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
    ':generateContent?key=' + apiKey;

  const blob = file.getBlob();
  const base64Data = Utilities.base64Encode(blob.getBytes());
  const mimeType = blob.getContentType();

  const today = new Date();
  const currentYear = today.getFullYear();

  const uploaderHintText = uploaderHint
    ? '【参考情報】このファイルは「' + uploaderHint + '」のGoogleアカウントからアップロードされました。' +
      '書類の内容と矛盾しなければ、対象は' + uploaderHint + 'である可能性が高いです。' +
      'ただし書類の内容(学校名・学年など)が明らかに他の家族を示している場合は、内容の方を優先してください。\n\n'
    : '';

  const fileName = file.getName();
  let columnHintText = '';
  if (fileName.indexOf('ゆうき') !== -1 || fileName.indexOf('結気') !== -1 || fileName.indexOf('結貴') !== -1) {
    columnHintText =
      '【重要・表構造の説明】このファイル名(' + fileName + ')から、これは刈谷高校(ゆうき)の書類です。' +
      'この書類は「令和8年度年間行事予定」という表形式で、各月ごとに1つの表になっています。' +
      '各月の表は、見出し行に「高校」と「附属中」という2つの見出しが左右に並んでおり、' +
      'その下の日付ごとの行も、罫線によって左半分(高校の欄)と右半分(附属中の欄)にはっきり分かれています。\n' +
      '出力してよいのは、罫線の**左側、「高校」という見出しの真下にある欄の文字だけ**です。' +
      '罫線の右側、「附属中」という見出しの真下にある欄(例えば「入学式」「入学式準備」' +
      '「クラス写真(1限)・個人写真(1年)」のような、中学1年生を対象にした文言が多い欄)は、' +
      '同じ行に並んでいても完全に別の集団(附属中学)向けの内容なので、1文字も読み取らず、出力に含めないでください。\n' +
      '各日付の行を処理する際は、必ず「これは左の高校欄の文字か、右の附属中欄の文字か」を欄の位置で判定してから' +
      '出力するかどうかを決めてください。\n\n';
  }

  const prompt =
    'これは家族の習い事・部活・学校行事・会社行事等のスケジュール表(画像またはPDF)です。\n\n' +
    uploaderHintText +
    columnHintText +
    '【家族プロフィール(あくまで「誰の予定か」を特定するための参考情報です。' +
    'ここに書かれている内容(習い事の曜日・時間など)から予定を新たに作り出すことは絶対にしないでください。' +
    '実際にその予定を作ってよいのは、今処理している書類に、その内容が文字として書かれている場合のみです)】\n' +
    FAMILY_PROFILE_ + '\n\n' +
    '【書類の読み取り・判定ルール】\n' + CONTENT_RULES_ + '\n\n' +
    '【日本の国民の祝日一覧(参考用、正確な日付はこちらを必ず使用してください)】\n' + JAPAN_HOLIDAYS_ + '\n\n' +
    '【重要な前提確認】以下のオレンジ日付抽出ルールは、書類が「月間の日付マス目だけで構成され、' +
    'オレンジ色のハッチングと白地の塗り分けのみで、学校名・行事名・時間割などの文字情報がほとんど無い、' +
    '一志個人の会社カレンダーそのもの」である場合にのみ適用してください。' +
    '学校の時間割・行事予定表・部活動予定・コミュニティー(自治区)の事業計画表・リスト形式の表など、' +
    '他の内容が書かれている書類には絶対にこのルールを適用しないでください。' +
    'これらの書類が「一志さんに関する書類だから」という理由だけで、' +
    'このオレンジ日付の仕組みを流用することも絶対にしないでください。' +
    '判断に迷う場合は、このルールを適用せず、orange_datesという項目自体を一切出力しないでください。\n\n' +
    'この書類が一志の会社カレンダーだと確認できた場合のみ、書類全体(全ての月)を1日ずつ漏れなく確認し、' +
    'オレンジ色になっている日付を全て(土日・祝日を問わず)リストアップしてください。' +
    '判断や分類は不要です。単純に「オレンジ色かどうか」だけを見て、該当する日付を全部集めてください。' +
    '【重要】「土日は基本的にオレンジのはず」といった一般的な思い込みでパターンを当てはめず、' +
    '画像の中の該当する日付のマスを実際に1つずつ視覚的に確認してください。' +
    '特に、祝日(上記リストの19日)の中には、オレンジではなく白地(稼働日)になっている例外がいくつか含まれています。' +
    'この例外を見落とさないことが最も重要です。土日であっても、実際に画像でオレンジ色になっていることを確認してから含めてください。' +
    '以下の形式で、配列内の1つの要素として出力してください。\n' +
    '{"orange_dates": ["YYYY-MM-DD", "YYYY-MM-DD", ...]}\n\n' +
    '上記を踏まえ、記載されている全ての予定を、以下のJSON配列形式のみで出力してください。' +
    '説明文や前置き、コードブロック記号(```)は一切つけないでください。\n\n' +
    '各要素の形式:\n' +
    '{"name": "対象の家族の名前(不明なら空文字)", "title": "予定の内容(例: 卓球部練習)", ' +
    '"date": "YYYY-MM-DD形式", "start_time": "HH:MM形式(24時間表記、不明なら空文字)", ' +
    '"end_time": "HH:MM形式(不明なら空文字)", "location": "場所(不明なら空文字)", ' +
    '"description": "補足事項があれば記載、なければ空文字"}\n\n' +
    'nameは必ず「みつき」「ゆうき」「一志」「きくみ」「ちあき」「家族」のいずれか、' +
    'またはどうしても特定できない場合のみ空文字にしてください。他の表記(苗字、ニックネーム等)は使わないでください。\n\n' +
    '【出力の最重要ルール】\n' +
    '・【最優先】書類に実際に書かれていない予定・日付・件名を、絶対に推測や創作で作らないでください。' +
    '一般的な学校でありそうな行事(口座振替日、定期的な行事など)を、書類に書かれていないのに' +
    '「あるはず」と補完することも禁止します。書類を見て、そこに書いてある文字だけを根拠にしてください。\n' +
    '・日付は書類に印字されている数字を正確に読み取ってください。近い日付と混同したり、覚えやすい日付に' +
    '置き換えたりしないでください。特に、表の下にある「備考」「注記」欄に書かれた大まかな期間(例:' +
    '「9/22〜26◯◯来校」のような書き方)は、あくまで補足の参考情報です。日付を決める際は、' +
    '必ず日ごとの表本体に記載されている具体的な日付を優先してください。備考欄の期間表記をそのまま' +
    '予定のdateやタイトルに使うことは避けてください。\n' +
    '・多少読み取りに自信が無い内容でも、書類に実際に記載されている情報であれば、' +
    '省略せずになるべく出力に含めてください。見落とす(拾い漏らす)よりも、' +
    '多めに拾っておく方を優先してください(拾いすぎた分は人が後で消せますが、' +
    '見落とした分は人が入力し直す必要があり負担が大きいためです)。' +
    'ただし、これは「書類に書かれていない内容を創作してよい」という意味ではありません。' +
    'あくまで書類に実在する文字を根拠にした上で、読み取りに自信が無くても出力する、という意味です。\n' +
    '・日付に年が書かれていない場合は' + currentYear + '年と仮定してください。\n' +
    '・時刻の指定がない予定は終日予定として扱い、start_time/end_timeは空文字にしてください。\n' +
    '・titleや文中に波ダッシュ「〜」などの特殊文字は使わず、「から」など一般的な日本語に置き換えてください。\n' +
    '・同じ日に複数の行事がある場合は、行事ごとに別々の要素に分けて出力してください(1つのtitleに複数の行事名を連結しないでください)。\n' +
    '・予定が複数ある場合は配列に全て含めてください。書類に書かれている予定は1件も見落とさないよう、' +
    '書類の隅々まで確認してください。\n' +
    '・「休日」「会社稼働日」に類する予定は、上記のorange_datesの仕組みだけで処理します。' +
    'それ以外の箇所で、自分の判断で「休日」「会社稼働日」のような予定を作ることは絶対にしないでください。';

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } },
        ],
      },
    ],
  };

  // 1回の実行の中での再試行は1回まで(最初の1回+再試行1回)。
  // 無料枠では失敗した呼び出しも1日の回数に数えられるため、同じ実行の中で何度も試さない(2026-09-28の枠切れ対策)。
  // 一時的な混雑(503、1分あたりの上限の429)だけ再試行し、1日の上限(429)やその他のエラーは再試行しない。
  const maxAttempts = 2;
  let response;
  let responseCode;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (onCall) onCall(model);
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    responseCode = response.getResponseCode();

    if (responseCode === 200) break;

    const kind = classifyGeminiError_(responseCode, response.getContentText());
    if (kind === 'busy' && attempt < maxAttempts) {
      Logger.log('Gemini APIが一時的に混雑(' + responseCode + ')。10秒待って再試行します。(' + model + ')');
      Utilities.sleep(10 * 1000);
      continue;
    }
    const err = new Error('Gemini APIエラー(' + responseCode + '): ' + response.getContentText());
    err.geminiKind = kind;
    err.geminiModel = model;
    throw err;
  }

  const json = JSON.parse(response.getContentText());
  let text = json.candidates[0].content.parts[0].text;

  // 万一```json などが付いてしまった場合の保険
  text = text.replace(/```json/g, '').replace(/```/g, '').trim();

  Logger.log('Geminiの生レスポンス: ' + text);

  let rawEvents = JSON.parse(text);
  // Geminiが配列ではなく単体のオブジェクトで返してしまった場合の保険
  if (!Array.isArray(rawEvents)) {
    rawEvents = [rawEvents];
  }
  return resolveHolidayChecks_(rawEvents);
}

// ==== Gemini APIのエラーの種類を判定する ====
// 'busy': Google側の一時的な混雑(503)、または1分あたりの上限(429) → 時間を置けば直る
// 'daily': そのモデルの1日の上限(429 RESOURCE_EXHAUSTED、quotaIdに「PerDay」を含む) → 次のモデルに切り替える
// 'other': それ以外(400など)
function classifyGeminiError_(responseCode, bodyText) {
  if (responseCode === 503) return 'busy';
  if (responseCode === 429) {
    return /PerDay/.test(bodyText || '') ? 'daily' : 'busy';
  }
  return 'other';
}

// ==== 祝日一覧の文字列(YYYY-MM-DD 名称)から、日付→祝日名の対応表を作る ====
function buildHolidayNameMap_() {
  const map = {};
  JAPAN_HOLIDAYS_.split('\n').forEach(function (line) {
    const spaceIndex = line.indexOf(' ');
    if (spaceIndex > 0) {
      const date = line.substring(0, spaceIndex);
      const name = line.substring(spaceIndex + 1);
      map[date] = name;
    }
  });
  return map;
}

// ==== 同じ名前・同じ内容(name+title)の終日予定が、日付で連続している場合に1件へまとめる ====
function mergeConsecutiveSameTitleEvents_(events) {
  const groups = {};
  const others = [];

  events.forEach(function (ev) {
    // 時刻指定がある予定(部活の練習時間など)は対象外。終日予定だけをまとめる対象にする
    if (!ev.start_time && ev.date && ev.title) {
      const key = (ev.name || '') + '||' + ev.title;
      if (!groups[key]) groups[key] = [];
      groups[key].push(ev);
    } else {
      others.push(ev);
    }
  });

  const merged = [];
  Object.keys(groups).forEach(function (key) {
    const group = groups[key].slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });

    let runEvents = [group[0]];
    let prevDate = new Date(group[0].date + 'T00:00:00');

    for (let i = 1; i < group.length; i++) {
      const d = new Date(group[i].date + 'T00:00:00');
      const diffDays = Math.round((d.getTime() - prevDate.getTime()) / 86400000);
      if (diffDays === 1) {
        runEvents.push(group[i]);
      } else {
        merged.push(buildMergedEvent_(runEvents));
        runEvents = [group[i]];
      }
      prevDate = d;
    }
    merged.push(buildMergedEvent_(runEvents));
  });

  return others.concat(merged);
}

// ==== 連続する同名予定のグループを、1件の予定(複数日にまたがる場合はdescriptionに期間を明記)にまとめる ====
function buildMergedEvent_(runEvents) {
  if (runEvents.length === 1) {
    return runEvents[0]; // 単独日はそのまま
  }
  const first = runEvents[0];
  const last = runEvents[runEvents.length - 1];
  return {
    name: first.name,
    title: first.title,
    date: first.date,
    start_time: '',
    end_time: '',
    location: first.location || '',
    description: (first.description ? first.description + ' / ' : '') + first.date + '〜' + last.date,
    multiDayEndDate: last.date, // registerEvents_側で複数日イベントとして扱うための目印
  };
}

// ==== ①オレンジ(休日)の平日は全て「一志休日」 ②祝日一覧のうちオレンジに含まれない日だけ「会社稼働日」 ====
// 出力するかどうかの判断はGeminiに頼らず、ここで確実に行う
function resolveHolidayChecks_(rawEvents) {
  const holidayNameMap = buildHolidayNameMap_(); // 日付 → 祝日名
  let normalEvents = [];
  let orangeDates = null;

  rawEvents.forEach(function (ev) {
    if (ev.orange_dates) {
      orangeDates = ev.orange_dates;
    } else {
      normalEvents.push(ev);
    }
  });

  // 安全策: 「休日」「稼働日」に類する自由記述の予定は、会社カレンダー由来の想定外の混入である可能性が高いため、
  // orange_datesの有無に関わらず常に取り除く(正規の「休日」「会社稼働日」はこの後コード側で確定的に作る)
  normalEvents = normalEvents.filter(function (ev) {
    const looksLikeFreeformHoliday =
      ev.title && (ev.title.indexOf('休日') !== -1 || ev.title.indexOf('稼働日') !== -1);
    return !looksLikeFreeformHoliday;
  });

  if (!orangeDates) {
    // オレンジ日付の報告が無い = 会社カレンダーではないと判定された書類
    return normalEvents;
  }

  const orangeFullSet = {}; // 土日を含む、全オレンジ日付(②の判定用)
  const orangeWeekdaySet = {}; // 土日を除いたオレンジ日付(①のイベント作成用)

  orangeDates.forEach(function (dateStr) {
    orangeFullSet[dateStr] = true;
  });

  // ① オレンジ(休日)の平日は、祝日と一致するかに関わらず全て「休日」
  orangeDates.forEach(function (dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay(); // 0=日, 6=土
    const isWeekend = dow === 0 || dow === 6;
    if (isWeekend) return; // 土日は除外

    orangeWeekdaySet[dateStr] = true;
    normalEvents.push({
      name: '一志',
      title: '休日',
      date: dateStr,
      start_time: '',
      end_time: '',
      location: '',
      description: '',
    });
  });

  // ② 祝日一覧(19日)のうち、実際にはオレンジになっていない日(土日を含めて判定) → 白地(稼働日)の例外
  Object.keys(holidayNameMap).forEach(function (date) {
    if (!orangeFullSet[date]) {
      normalEvents.push({
        name: '一志',
        title: '会社稼働日(' + holidayNameMap[date] + ')',
        date: date,
        start_time: '',
        end_time: '',
        location: '',
        description: '',
      });
    }
  });

  return normalEvents;
}

// ==== 抽出したJSONをGoogleカレンダーに登録 ====
// skippedLinesOut(省略可)を渡すと、既存の予定と同じためスキップした予定を「日付 / 予定名」の形で追加する
function registerEvents_(events, calendarId, sourceLabel, skippedLinesOut) {
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    throw new Error('カレンダーが見つかりません。CALENDAR_IDを確認してください。');
  }

  const sourceTag = sourceLabel ? ' [取込元: ' + sourceLabel + ']' : '';

  let successCount = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev.date || !ev.title) {
      successCount++; // スキップ対象も「処理済み」として数える(無限ループ防止)
      continue;
    }

    const eventTitle = ev.name ? '【' + ev.name + '】' + ev.title : '【要確認】' + ev.title;
    const finalDescription = (ev.description || '') + sourceTag;

    try {
      // 重複防止: 同じ日にすでに同じタイトルの予定があればスキップする
      const dayStart = new Date(ev.date + 'T00:00:00');
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const existing = calendar.getEvents(dayStart, dayEnd);
      const alreadyExists = existing.some(function (e) {
        return e.getTitle() === eventTitle;
      });
      if (alreadyExists) {
        if (skippedLinesOut) {
          skippedLinesOut.push(ev.date + ' / ' + eventTitle + (ev.start_time ? '(' + ev.start_time + ')' : ''));
        }
        successCount++;
        continue;
      }

      if (ev.start_time) {
        const startDateTime = new Date(ev.date + 'T' + ev.start_time + ':00');
        let endDateTime = ev.end_time
          ? new Date(ev.date + 'T' + ev.end_time + ':00')
          : new Date(startDateTime.getTime() + 60 * 60 * 1000); // 終了時刻不明なら1時間後

        // Geminiの抽出ミスで終了時刻が開始時刻以前になっている場合、1時間後に補正する
        if (endDateTime.getTime() <= startDateTime.getTime()) {
          endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);
        }

        calendar.createEvent(eventTitle, startDateTime, endDateTime, {
          location: ev.location || '',
          description: finalDescription,
        });
      } else {
        // 時刻が不明な場合は終日予定として登録
        const dateOnly = new Date(ev.date + 'T00:00:00');
        if (ev.multiDayEndDate) {
          // 複数日にまたがる終日予定(終了日は「翌日」を指定する仕様のため+1日する)
          const endDateExclusive = new Date(ev.multiDayEndDate + 'T00:00:00');
          endDateExclusive.setDate(endDateExclusive.getDate() + 1);
          calendar.createAllDayEvent(eventTitle, dateOnly, endDateExclusive, {
            location: ev.location || '',
            description: finalDescription,
          });
        } else {
          calendar.createAllDayEvent(eventTitle, dateOnly, {
            location: ev.location || '',
            description: finalDescription,
          });
        }
      }
      successCount++;
      Utilities.sleep(300); // レート制限回避のため0.3秒待機
    } catch (e) {
      // 1日のクォータ上限などで失敗した場合、ここで打ち切って
      // 「successCount件はすでに登録済み」として呼び出し元に返す(重複防止)
      Logger.log('登録エラーのため中断(' + successCount + '件は登録済み): ' + e.message);
      return successCount;
    }
  }
  return successCount;
}

/**
 * ■ フォルダID / カレンダーIDの調べ方
 * ・フォルダID: 「家族スケジュール」フォルダをDriveで開いた時のURL
 *   https://drive.google.com/drive/folders/【ここがフォルダID】
 * ・カレンダーID: Googleカレンダー画面の左側で対象カレンダーの
 *   「⋮」→「設定と共有」→ 下の方の「カレンダーの統合」欄にある
 *   「カレンダーID」(例: xxxxxx@group.calendar.google.com)
 */

// ==== 誤登録されたイベントの確認(削除はしない、ログ表示のみ) ====
function previewJunkEvents() {
  const config = getConfig_();
  const calendar = CalendarApp.getCalendarById(config.calendarId);

  // 消したい候補のタイトルをここに列挙(必要に応じて追加・修正してください)
  const junkTitles = ['休日'];

  // 対象期間(必要に応じて調整してください)
  const start = new Date('2026-01-01');
  const end = new Date('2027-01-01');

  const events = calendar.getEvents(start, end);
  let count = 0;
  events.forEach(function (ev) {
    if (junkTitles.indexOf(ev.getTitle()) !== -1) {
      Logger.log(ev.getStartTime() + ' / ' + ev.getTitle());
      count++;
    }
  });
  Logger.log('該当件数: ' + count + '件');
}

// ==== 「休日」など不要な予定をまとめて削除 ====
function deleteJunkEvents() {
  const config = getConfig_();
  const calendar = CalendarApp.getCalendarById(config.calendarId);

  // previewJunkEventsで確認した内容と必ず同じリストにしてください
  const junkTitles = ['休日'];

  const start = new Date('2026-01-01');
  const end = new Date('2027-01-01');

  const events = calendar.getEvents(start, end);
  let count = 0;
  events.forEach(function (ev) {
    if (junkTitles.indexOf(ev.getTitle()) !== -1) {
      ev.deleteEvent();
      count++;
    }
  });
  Logger.log('削除件数: ' + count + '件');
}

// ==== 「(AM)〜(PM)」のように連結されたタイトルの確認(削除はしない) ====
function previewAmPmMergedEvents() {
  const config = getConfig_();
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  const start = new Date('2026-01-01');
  const end = new Date('2027-01-01');

  const events = calendar.getEvents(start, end);
  let count = 0;
  events.forEach(function (ev) {
    const title = ev.getTitle();
    if (title.indexOf('(AM)') !== -1 || title.indexOf('（AM）') !== -1) {
      Logger.log(ev.getStartTime() + ' / ' + title);
      count++;
    }
  });
  Logger.log('該当件数: ' + count + '件');
}

// ==== 「(AM)〜(PM)」のように連結されたタイトルを削除 ====
function deleteAmPmMergedEvents() {
  const config = getConfig_();
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  const start = new Date('2026-01-01');
  const end = new Date('2027-01-01');

  const events = calendar.getEvents(start, end);
  let count = 0;
  events.forEach(function (ev) {
    const title = ev.getTitle();
    if (title.indexOf('(AM)') !== -1 || title.indexOf('（AM）') !== -1) {
      ev.deleteEvent();
      count++;
    }
  });
  Logger.log('削除件数: ' + count + '件');
}

// ==== 【要確認】タグの予定を一覧表示(他学年の混入チェック用。削除はしない) ====
function previewUnconfirmedEvents() {
  const config = getConfig_();
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  const start = new Date('2026-01-01');
  const end = new Date('2027-01-01');

  const events = calendar.getEvents(start, end);
  let count = 0;
  events.forEach(function (ev) {
    if (ev.getTitle().indexOf('【要確認】') === 0) {
      Logger.log(ev.getStartTime() + ' / ' + ev.getTitle());
      count++;
    }
  });
  Logger.log('該当件数: ' + count + '件');
}

// ==== 「スケジュール」というタイトルの予定を診断(繰り返し予定か単発か確認) ====
function diagnoseScheduleTitledEvents() {
  const config = getConfig_();
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  const start = new Date('2026-01-01');
  const end = new Date('2027-01-01');

  const events = calendar.getEvents(start, end);
  let count = 0;
  events.forEach(function (ev) {
    if (ev.getTitle() === 'スケジュール') {
      Logger.log(ev.getStartTime() + ' / 繰り返し予定か: ' + ev.isRecurringEvent());
      count++;
    }
  });
  Logger.log('該当件数: ' + count + '件');
}

// ==== 作成日時で絞り込んで確認(削除はしない) ====
// ※事前に左メニュー「サービス」+ から「Calendar API」を追加してください
function previewEventsCreatedSince() {
  const config = getConfig_();
  const cutoff = new Date('2026-07-25T20:00:00+09:00'); // このスクリプトの検証を始めた時刻(必要に応じて調整)
  let pageToken = null;
  let count = 0;
  do {
    const response = Calendar.Events.list(config.calendarId, {
      timeMin: new Date('2024-01-01').toISOString(),
      timeMax: new Date('2028-01-01').toISOString(),
      singleEvents: true,
      maxResults: 2500,
      pageToken: pageToken,
    });
    const items = response.items || [];
    items.forEach(function (item) {
      const created = new Date(item.created);
      if (created >= cutoff) {
        Logger.log(created + ' / ' + item.summary);
        count++;
      }
    });
    pageToken = response.nextPageToken;
  } while (pageToken);
  Logger.log('該当件数: ' + count + '件(2026-07-25 20時以降に作成されたと推定される予定)');
}

// ==== 作成日時で絞り込んで削除 ====
function deleteEventsCreatedSince() {
  const config = getConfig_();
  const cutoff = new Date('2026-07-25T20:00:00+09:00'); // previewと必ず同じ値にしてください
  let pageToken = null;
  let count = 0;
  do {
    const response = Calendar.Events.list(config.calendarId, {
      timeMin: new Date('2024-01-01').toISOString(),
      timeMax: new Date('2028-01-01').toISOString(),
      singleEvents: true,
      maxResults: 2500,
      pageToken: pageToken,
    });
    const items = response.items || [];
    items.forEach(function (item) {
      const created = new Date(item.created);
      if (created >= cutoff) {
        try {
          Calendar.Events.remove(config.calendarId, item.id);
          count++;
          Utilities.sleep(300);
        } catch (e) {
          Logger.log('削除エラー(スキップして続行): ' + item.summary + ' / ' + e.message);
          Utilities.sleep(2000);
        }
      }
    });
    pageToken = response.nextPageToken;
  } while (pageToken);
  Logger.log('削除件数: ' + count + '件');
}
function previewOtherGradeCandidates() {
  const config = getConfig_();
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  const start = new Date('2026-01-01');
  const end = new Date('2027-01-01');

  // 「1年」「3年」を含み、かつ「2年」を含まないものを候補として表示
  const events = calendar.getEvents(start, end);
  let count = 0;
  events.forEach(function (ev) {
    const title = ev.getTitle();
    const hasOtherGrade = title.indexOf('1年') !== -1 || title.indexOf('3年') !== -1;
    const hasOwnGrade = title.indexOf('2年') !== -1;
    if (hasOtherGrade && !hasOwnGrade) {
      Logger.log(ev.getStartTime() + ' / ' + title);
      count++;
    }
  });
  Logger.log('候補件数: ' + count + '件(誤検知の可能性があるため、必ず目視確認してから個別に削除してください)');
}

// ==== 特定の取込元(ファイル名)に該当する予定を検索し、一覧(HTML用)を返す(削除はしない) ====
// ==== Geminiにもう一度、書類と登録結果を照合させて簡易チェックレポートを作る ====
function performSelfCheck_(file, apiKey, registeredLines, skippedLines) {
  const model = 'gemini-3.5-flash-lite';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
    ':generateContent?key=' + apiKey;

  const blob = file.getBlob();
  const base64Data = Utilities.base64Encode(blob.getBytes());
  const mimeType = blob.getContentType();

  const registeredText = registeredLines.length > 0 ? registeredLines.join('\n') : '(登録された予定はありません)';
  const skipped = skippedLines || [];
  const skippedText = skipped.length > 0
    ? '\n\n【カレンダーに同じ予定が既にあったため、今回は登録をスキップした予定(これらは見落としではありません)】\n' +
      skipped.join('\n')
    : '';

  const prompt =
    'あなたはこの書類の内容と、すでに抽出・登録された以下の予定一覧を照合してください。\n\n' +
    '【登録済みの予定一覧】\n' + registeredText + skippedText + '\n\n' +
    '書類に実際に書かれているのに、上記のどちらの一覧にも無い予定(見落とし)、' +
    'または一覧にあるのに書類のどこにも書かれていない予定(誤り)が無いか確認し、' +
    '問題点だけを簡潔に箇条書きで報告してください。' +
    '問題が見当たらない場合は「問題は見つかりませんでした」とだけ書いてください。' +
    '前置きや余計な説明、感想は不要です。';

  const payload = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Data } }] }],
  };

  try {
    // 一時的なサーバー混雑(503)やレート超過(429)は、間隔を空けて最大3回リトライする
    const maxRetries = 3;
    let response;
    let responseCode;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      responseCode = response.getResponseCode();

      if (responseCode === 200) break;

      if ((responseCode === 503 || responseCode === 429) && attempt < maxRetries) {
        Logger.log('セルフチェック: Gemini APIが一時的に混雑(' + responseCode + ')。' + attempt * 10 + '秒待って再試行します。');
        Utilities.sleep(attempt * 10 * 1000);
      } else {
        break;
      }
    }
    if (responseCode !== 200) {
      return '(セルフチェックに失敗しました: ' + responseCode + ')';
    }
    const json = JSON.parse(response.getContentText());
    return json.candidates[0].content.parts[0].text.trim();
  } catch (e) {
    return '(セルフチェック中にエラーが発生しました: ' + e.message + ')';
  }
}

// ==== メールアドレスの配列から、空欄・重複を取り除く ====
function dedupeEmails_(emails) {
  const seen = {};
  const result = [];
  emails.forEach(function (email) {
    const trimmed = (email || '').trim();
    if (trimmed && !seen[trimmed]) {
      seen[trimmed] = true;
      result.push(trimmed);
    }
  });
  return result;
}

// ==== 取り込み完了の通知メールを送信(セルフチェック結果+確認/削除ボタン付き) ====
// ・登録内容の「確認」は、アップロード本人+一志+きくみの3人が可能
// ・登録内容の「削除」は、アップロード本人+一志の2人のみ可能(削除ボタンはこの2人にしか送らない)
// extractModel(省略可): 読み取りに使ったモデル { label, lite }。簡易モデル(lite)の場合は件名・本文で明示する
function sendNotificationEmail_(config, fileName, registeredCount, checkReport, uploaderEmail, skippedLines, extractModel) {
  const skipped = skippedLines || [];
  const isLite = !!(extractModel && extractModel.lite);
  let webAppUrl = config.webAppUrl || null; // 手動設定を優先
  if (!webAppUrl) {
    try {
      webAppUrl = ScriptApp.getService().getUrl();
    } catch (e) {
      webAppUrl = null;
    }
  }

  // 削除も可能な人(アップロード本人+一志)と、確認のみ可能な人(それ以外。ここではきくみ)を分ける
  const deleteRecipients = dedupeEmails_([uploaderEmail, config.notifyEmail]);
  const confirmOnlyRecipients = dedupeEmails_([config.kikumiEmail]).filter(function (email) {
    return deleteRecipients.indexOf(email) === -1;
  });

  const escapedReport = checkReport.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const subject = '【家族スケジュール自動登録】' + (isLite ? '【簡易モデルで読み取り】' : '') + fileName + ' を取り込みました(' + registeredCount + '件' +
    (skipped.length > 0 ? '、既存と同じ' + skipped.length + '件はスキップ' : '') + ')';
  const escapeHtml = function (text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  const skippedHtml = skipped.length > 0
    ? '<p>次の ' + skipped.length + ' 件は、カレンダーに同じ予定が既にあったため登録をスキップしました(見落としではありません)。</p><ul>' +
      skipped.map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') + '</ul>'
    : '';
  const modelHtml = extractModel
    ? (isLite
      ? '<p style="color:#DB4437;"><b>通常のモデルが本日の上限に達したため、簡易モデル(' + escapeHtml(extractModel.label) +
        ')で読み取りました。精度が低い可能性があります。登録内容を確認してください。</b></p>'
      : '<p style="color:#888;">読み取りモデル: ' + escapeHtml(extractModel.label) + '</p>')
    : '';

  function buildHtmlBody_(includeDeleteButton) {
    let buttonsHtml = '';
    if (config.webAppToken && webAppUrl) {
      const previewUrl = webAppUrl + '?action=preview&file=' + encodeURIComponent(fileName) + '&token=' + encodeURIComponent(config.webAppToken);
      buttonsHtml =
        '<p>' +
        '<a href="' + previewUrl + '" style="display:inline-block;padding:10px 20px;background:#4285F4;' +
        'color:#ffffff;text-decoration:none;border-radius:4px;margin-right:10px;">登録内容を確認する</a>';
      if (includeDeleteButton) {
        const deleteUrl = webAppUrl + '?action=delete&file=' + encodeURIComponent(fileName) + '&token=' + encodeURIComponent(config.webAppToken);
        buttonsHtml +=
          '<a href="' + deleteUrl + '" style="display:inline-block;padding:10px 20px;background:#DB4437;' +
          'color:#ffffff;text-decoration:none;border-radius:4px;">この取り込み分を削除する</a>';
      }
      buttonsHtml += '</p>';
    } else {
      buttonsHtml = '<p style="color:#888;">(ボタンを表示するには、ウェブアプリの公開とWEBAPP_TOKENの設定が必要です)</p>';
    }

    return (
      '<p>「' + fileName + '」から ' + registeredCount + ' 件の予定を登録しました。</p>' +
      modelHtml +
      skippedHtml +
      '<p><b>AIによるセルフチェック結果:</b></p>' +
      '<pre style="white-space:pre-wrap;font-family:inherit;background:#f5f5f5;padding:10px;border-radius:4px;">' +
      escapedReport + '</pre>' +
      buttonsHtml
    );
  }

  if (deleteRecipients.length > 0) {
    MailApp.sendEmail({
      to: deleteRecipients.join(','),
      subject: subject,
      htmlBody: buildHtmlBody_(true),
    });
  }
  if (confirmOnlyRecipients.length > 0) {
    MailApp.sendEmail({
      to: confirmOnlyRecipients.join(','),
      subject: subject,
      htmlBody: buildHtmlBody_(false),
    });
  }
}

// ==== ウェブアプリのエントリーポイント(通知メール内のボタンから呼ばれる) ====
function doGet(e) {
  // LINE Webhook用のURL(?webhook_token=...)にブラウザ等でGETアクセスした場合の診断用メッセージ。
  // LINEからの実際のWebhook呼び出しはPOST(doPost)で行われるため、ここには来ない。
  if (e.parameter && e.parameter.webhook_token) {
    return HtmlService.createHtmlOutput(
      '<p>このURLはLINE Webhook用のエンドポイントです。ブラウザでのGETアクセスでは何も起きません' +
      '(LINEサーバーからのPOSTリクエストのみ処理されます)。<br>' +
      '疎通確認は、LINE Developersコンソールの「Webhook URLを検証」ボタンから行ってください。</p>'
    );
  }

  const config = getConfig_();
  const action = e.parameter.action;
  const fileParam = e.parameter.file;
  const token = e.parameter.token;

  if (!config.webAppToken || token !== config.webAppToken) {
    return HtmlService.createHtmlOutput('<p>アクセスが拒否されました(トークンが一致しません)。</p>');
  }
  if (!fileParam) {
    return HtmlService.createHtmlOutput('<p>ファイル名が指定されていません。</p>');
  }

  if (action === 'preview') {
    const lines = previewBySourceFile_(fileParam, config.calendarId);
    const html =
      '<h3>' + fileParam + ' の登録内容(' + lines.length + '件)</h3><ul>' +
      lines.map(function (l) { return '<li>' + l.replace(/</g, '&lt;') + '</li>'; }).join('') +
      '</ul>';
    return HtmlService.createHtmlOutput(html);
  } else if (action === 'delete') {
    const count = deleteBySourceFile_(fileParam, config.calendarId);
    return HtmlService.createHtmlOutput('<p>「' + fileParam + '」から取り込まれた予定を ' + count + ' 件削除しました。</p>');
  }
  return HtmlService.createHtmlOutput('<p>不明な操作です。</p>');
}

// ==== 特定の取込元(ファイル名)に該当する予定を検索し、一覧(HTML用)を返す(削除はしない) ====
function previewBySourceFile_(sourceFile, calendarId) {
  const calendar = CalendarApp.getCalendarById(calendarId);
  const start = new Date('2024-01-01');
  const end = new Date('2028-01-01');

  const events = calendar.getEvents(start, end);
  const lines = [];
  events.forEach(function (ev) {
    const desc = ev.getDescription() || '';
    if (desc.indexOf('[取込元: ' + sourceFile) !== -1) {
      lines.push(Utilities.formatDate(ev.getStartTime(), 'Asia/Tokyo', 'yyyy-MM-dd') + ' / ' + ev.getTitle());
    }
  });
  return lines;
}

// ==== 特定の取込元(ファイル名)に該当する予定を削除し、削除件数を返す ====
function deleteBySourceFile_(sourceFile, calendarId) {
  const calendar = CalendarApp.getCalendarById(calendarId);
  const start = new Date('2024-01-01');
  const end = new Date('2028-01-01');

  const events = calendar.getEvents(start, end);
  let count = 0;
  events.forEach(function (ev) {
    const desc = ev.getDescription() || '';
    if (desc.indexOf('[取込元: ' + sourceFile) !== -1) {
      try {
        ev.deleteEvent();
        count++;
        Utilities.sleep(300);
      } catch (e) {
        Logger.log('削除エラー(スキップして続行): ' + e.message);
        Utilities.sleep(2000);
      }
    }
  });
  return count;
}

// ==== 特定の取込元(ファイル名)から作られた予定だけを一覧表示(削除はしない) ====
// スクリプトプロパティ「TARGET_SOURCE_FILE」に、確認したいファイル名の一部を設定してから実行してください
function previewEventsBySourceFile() {
  const targetSourceFile = PropertiesService.getScriptProperties().getProperty('TARGET_SOURCE_FILE');
  if (!targetSourceFile) {
    Logger.log('スクリプトプロパティ「TARGET_SOURCE_FILE」が未設定です。プロジェクトの設定画面で追加してください。');
    return;
  }
  const config = getConfig_();
  const lines = previewBySourceFile_(targetSourceFile, config.calendarId);
  lines.forEach(function (line) {
    Logger.log(line);
  });
  Logger.log('該当件数: ' + lines.length + '件(取込元: ' + targetSourceFile + ')');
}

// ==== 特定の取込元(ファイル名)から作られた予定だけを削除 ====
// previewEventsBySourceFileと同じ「TARGET_SOURCE_FILE」の値を使います
function deleteEventsBySourceFile() {
  const targetSourceFile = PropertiesService.getScriptProperties().getProperty('TARGET_SOURCE_FILE');
  if (!targetSourceFile) {
    Logger.log('スクリプトプロパティ「TARGET_SOURCE_FILE」が未設定です。プロジェクトの設定画面で追加してください。');
    return;
  }
  const config = getConfig_();
  const count = deleteBySourceFile_(targetSourceFile, config.calendarId);
  Logger.log('削除件数: ' + count + '件(取込元: ' + targetSourceFile + ')');
}

// ==== このスクリプトが作成した予定を一覧表示(削除はしない) ====
// 「【」で始まるもの、または初期バグで無印になった「スケジュール」「休日」を対象とする
function previewAllAutomationEvents() {
  const config = getConfig_();
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  const start = new Date('2024-01-01');
  const end = new Date('2028-01-01');

  const events = calendar.getEvents(start, end);
  let count = 0;
  events.forEach(function (ev) {
    const title = ev.getTitle();
    if (title.indexOf('【') === 0 || title === 'スケジュール' || title === '休日') {
      count++;
    }
  });
  Logger.log('該当件数: ' + count + '件(このスクリプトが作成したと推定される予定)');
}

// ==== このスクリプトが作成した予定を一括削除(レート制限対策のウェイト付き) ====
function deleteAllAutomationEvents() {
  const config = getConfig_();
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  const start = new Date('2024-01-01');
  const end = new Date('2028-01-01');

  const events = calendar.getEvents(start, end);
  let count = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const title = ev.getTitle();
    if (title.indexOf('【') === 0 || title === 'スケジュール' || title === '休日') {
      try {
        ev.deleteEvent();
        count++;
        Utilities.sleep(300); // レート制限回避のため0.3秒待機
      } catch (e) {
        Logger.log('削除エラー(スキップして続行): ' + title + ' / ' + e.message);
        Utilities.sleep(2000); // エラー時は長めに待機してから続行
      }
    }
  }
  Logger.log('削除件数: ' + count + '件');
}

// ==== 「処理済み」フォルダの全ファイルを「家族スケジュール」フォルダに戻す ====
function resetProcessedFiles() {
  const config = getConfig_();
  const folder = DriveApp.getFolderById(config.folderId);
  const processedFolder = getOrCreateProcessedFolder_(folder);

  const files = processedFolder.getFiles();
  let count = 0;
  while (files.hasNext()) {
    const file = files.next();
    file.moveTo(folder);
    count++;
  }
  Logger.log(count + '件のファイルを「家族スケジュール」フォルダに戻しました。');
}

// ==== 【手動テスト用】Gemini 3.6 Flash での読み取りを試す(カレンダーには登録しない) ====
// 使い方: 「家族スケジュール」フォルダの中に「モデル比較テスト」フォルダを作り、試したい書類のコピーを入れてから、
// GASエディタでこの関数を実行する。結果は実行ログと「処理ログ.txt」に「[モデル比較テスト:3.6 Flash]」として記録される
// (「◯件登録」と表示されるが、カレンダーには登録しない)。1枚につき、3.6 Flash の1日の枠を1〜2回使う。
function testReadWithGemini36Flash() {
  testReadWithModel_('gemini-3.6-flash', '3.6 Flash');
}

function testReadWithModel_(modelId, label) {
  const config = getConfig_();
  const folder = DriveApp.getFolderById(config.folderId);
  const testFolders = folder.getFoldersByName('モデル比較テスト');
  if (!testFolders.hasNext()) {
    folder.createFolder('モデル比較テスト');
    Logger.log('「モデル比較テスト」フォルダを作成しました。試したい書類のコピーを入れてから、もう一度実行してください。');
    return;
  }
  const state = loadGeminiState_();
  const files = testFolders.next().getFiles();
  let count = 0;
  while (files.hasNext()) {
    const file = files.next();
    const mime = file.getMimeType();
    if (mime !== MimeType.PDF && mime.indexOf('image/') !== 0) continue;
    if (count > 0) Utilities.sleep(13 * 1000); // 1分あたり5回の上限を超えないよう間隔を空ける
    count++;
    const logName = '[モデル比較テスト:' + label + '・カレンダー未登録] ' + file.getName();
    try {
      const uploader = resolveUploader_(file, config);
      const events = callGeminiApi_(file, config.apiKey, uploader.name, modelId, function (id) {
        state.calls[id] = (state.calls[id] || 0) + 1;
      });
      writeProcessLog_(folder, logName, mergeConsecutiveSameTitleEvents_(events), null, label);
      Logger.log(logName + ': ' + events.length + '件を読み取りました。');
    } catch (e) {
      writeProcessLog_(folder, logName, [], e.message, label);
      Logger.log(logName + ': エラー ' + e.message);
    }
    saveGeminiState_(state);
  }
  logGeminiCallSummary_(state);
  Logger.log('テスト完了: ' + count + '件');
}
