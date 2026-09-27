/**
 * 家族スケジュール自動登録:LINE経由の画像・PDF取り込み
 * ------------------------------------------------------------
 * 家族それぞれのLINE個人チャネル(ゆうき用/みつき用/一志用/きくみ用)にスケジュールの画像やPDFが
 * 送られてきたら(転送も可)、Googleドライブの「家族スケジュール」フォルダ(スクリプトプロパティ FOLDER_ID)
 * に保存する。保存後のGemini解析・カレンダー登録・通知メールは、家族スケジュール自動登録.gs の
 * checkNewFiles() がこれまでどおり行う(受信の1分後に取り込み実行を予約して、定期実行を待たずに処理する)。
 *
 * ■ アップロード者(誰の分か)の決め方
 *   送信者のLINEアカウントではなく「受信したチャネルの持ち主」とする。
 *   (みつき用チャネルから届いたらみつきの分。現在は一志がみつき名義で登録していても、みつきの分として扱う)
 *   保存したファイルの説明欄に「line_uploader=みつき」のように記録し、家族スケジュール自動登録.gs 側で
 *   Driveのオーナー(=GASの実行者である一志)より優先して使う。
 *
 * ■ ファイル名
 *   LINE_(チャネルのローマ字)_(受信日時)_(メッセージID).拡張子
 *   PDF等のファイル送信の場合は、末尾に元のファイル名を付ける。
 *   人名(ゆうき等)をファイル名に入れないのは、家族スケジュール自動登録.gs がファイル名に「ゆうき」等が
 *   含まれると、ゆうき専用の読み取りルールを自動適用する仕組みになっているため(誤適用の防止)。
 *
 * ■ 返信(すべてreplyのため、月200通の無料枠を消費しない)
 *   ・保存成功:「受け取りました」(複数枚をまとめて送った場合は最後の1枚にだけ返信)
 *   ・保存失敗:再送またはDriveへの直接保存を案内
 *   ・動画・音声・画像/PDF以外のファイル:対応形式を案内
 *   ・検証用チャネル(崎家エージェント)は取り込み対象外(何もしない)
 * ------------------------------------------------------------
 */

var LINE_FEATURE_HANDLERS_ = (typeof LINE_FEATURE_HANDLERS_ !== 'undefined' && LINE_FEATURE_HANDLERS_) || [];
LINE_FEATURE_HANDLERS_.push({
  name: '家族スケジュール:画像・PDF取り込み',
  priority: 10,
  handle: function (ctx) { return scheduleIntakeHandleLineEvent_(ctx); },
});

// チャネル → 持ち主(家族の名前は FAMILY_EMAIL_MAP 等と同じ表記にする)
const SCHEDULE_INTAKE_CHANNEL_OWNERS_ = {
  YUKI: { name: 'ゆうき', slug: 'yuki' },
  MITSUKI: { name: 'みつき', slug: 'mitsuki' },
  KAZUSHI: { name: '一志', slug: 'kazushi' },
  KIKUMI: { name: 'きくみ', slug: 'kikumi' },
};

const SCHEDULE_INTAKE_CONTENT_URL_ = 'https://api-data.line.me/v2/bot/message/';

// ファイル送信で受け付ける拡張子 → 保存時のMIMEタイプ
const SCHEDULE_INTAKE_FILE_TYPES_ = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
};

const SCHEDULE_INTAKE_MSG_RECEIVED_ =
  'スケジュールを受け取りました。\n1〜2分後から順番にカレンダーへ登録します。登録が終わると確認メールが届きます。';
const SCHEDULE_INTAKE_MSG_FAILED_ =
  '保存に失敗しました。もう一度送るか、Googleドライブの「家族スケジュール」フォルダに直接保存してください。';
const SCHEDULE_INTAKE_MSG_UNSUPPORTED_ =
  'スケジュールの取り込みは、画像(写真・スクリーンショット)かPDFのみ対応しています。';

// ==== 窓口から呼ばれる受け取り関数。担当したら true を返す ====
function scheduleIntakeHandleLineEvent_(ctx) {
  const event = ctx.event;
  if (event.type !== 'message' || !event.message) return false;

  const owner = SCHEDULE_INTAKE_CHANNEL_OWNERS_[ctx.channel.key];
  if (!owner) return false; // 検証用チャネルなどは対象外

  const message = event.message;
  if (message.type === 'video' || message.type === 'audio') {
    ctx.reply(SCHEDULE_INTAKE_MSG_UNSUPPORTED_);
    return true;
  }
  if (message.type === 'file' && !scheduleIntakeFileExt_(message.fileName)) {
    ctx.reply(SCHEDULE_INTAKE_MSG_UNSUPPORTED_);
    return true;
  }
  if (message.type !== 'image' && message.type !== 'file') {
    return false; // テキスト・スタンプ等は担当外(天気配信の友だち登録などに回す)
  }

  try {
    const saved = scheduleIntakeSaveToDrive_(event, owner, ctx.accessToken);
    Logger.log('[' + ctx.channel.label + '] LINEから受信したファイルを保存しました: ' + saved.name +
      (saved.duplicate ? '(再送のため保存済みの分を使用)' : ''));
    requestFamilyScheduleRunSoon_('LINEから受信');
  } catch (err) {
    Logger.log('[' + ctx.channel.label + '] LINEからのファイル保存に失敗: ' + err.message);
    ctx.reply(SCHEDULE_INTAKE_MSG_FAILED_);
    return true;
  }

  // 複数枚をまとめて送った場合(imageSet)は、最後の1枚にだけ返信する
  const imageSet = message.imageSet;
  if (imageSet && imageSet.total && imageSet.index && imageSet.index < imageSet.total) {
    return true;
  }
  const countText = imageSet && imageSet.total > 1 ? '(' + imageSet.total + '枚)' : '';
  ctx.reply(SCHEDULE_INTAKE_MSG_RECEIVED_.replace('受け取りました。', '受け取りました' + countText + '。'));
  return true;
}

// ==== LINEからファイル本体を取得してDriveに保存する ====
function scheduleIntakeSaveToDrive_(event, owner, accessToken) {
  const message = event.message;
  const messageId = String(message.id);

  // LINE側の再送(同じメッセージが2回届く)で二重保存しないよう、メッセージIDで既存ファイルを探す
  // (処理済みフォルダへ移動した後でも見つかるよう、Drive全体を検索し、説明欄のメッセージIDで完全一致を確認する)
  const existing = DriveApp.searchFiles("title contains '" + messageId + "' and trashed = false");
  while (existing.hasNext()) {
    const candidate = existing.next();
    const description = candidate.getDescription() || '';
    if (description.split('\n').indexOf('line_message_id=' + messageId) !== -1) {
      return { name: candidate.getName(), duplicate: true };
    }
  }

  const config = getConfig_();
  if (!config.folderId) throw new Error('スクリプトプロパティ FOLDER_ID が未設定です');

  const blob = scheduleIntakeFetchContent_(message, accessToken);

  const receivedAt = Utilities.formatDate(new Date(event.timestamp || Date.now()), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
  const baseName = 'LINE_' + owner.slug + '_' + receivedAt + '_' + messageId;
  let fileName;
  let mimeType;
  if (message.type === 'file') {
    const ext = scheduleIntakeFileExt_(message.fileName);
    mimeType = SCHEDULE_INTAKE_FILE_TYPES_[ext];
    fileName = baseName + '_' + message.fileName;
  } else {
    mimeType = scheduleIntakeNormalizeImageMime_(blob.getContentType());
    fileName = baseName + '.' + scheduleIntakeExtForMime_(mimeType);
  }
  blob.setContentType(mimeType);
  blob.setName(fileName);

  const file = DriveApp.getFolderById(config.folderId).createFile(blob);
  file.setDescription(
    'line_uploader=' + owner.name + '\n' +
    'line_channel=' + owner.slug + '\n' +
    'line_message_id=' + messageId
  );
  return { name: fileName, duplicate: false };
}

// ==== メッセージのコンテンツ(画像・ファイル本体)を取得 ====
function scheduleIntakeFetchContent_(message, accessToken) {
  // 外部URLで提供される画像(contentProvider.type === 'external')はそのURLから直接取得する
  if (message.contentProvider && message.contentProvider.type === 'external' && message.contentProvider.originalContentUrl) {
    const extResponse = UrlFetchApp.fetch(message.contentProvider.originalContentUrl, { muteHttpExceptions: true });
    if (extResponse.getResponseCode() !== 200) {
      throw new Error('外部URLからの取得に失敗(' + extResponse.getResponseCode() + ')');
    }
    return extResponse.getBlob();
  }

  if (!accessToken) throw new Error('チャネルアクセストークンが未設定です');
  const response = UrlFetchApp.fetch(SCHEDULE_INTAKE_CONTENT_URL_ + message.id + '/content', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('LINEからのコンテンツ取得に失敗(' + response.getResponseCode() + '): ' + response.getContentText());
  }
  return response.getBlob();
}

// ==== ファイル名の拡張子が対応形式ならその拡張子(小文字)を、対応外なら '' を返す ====
function scheduleIntakeFileExt_(fileName) {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName || '');
  if (!match) return '';
  const ext = match[1].toLowerCase();
  return SCHEDULE_INTAKE_FILE_TYPES_[ext] ? ext : '';
}

function scheduleIntakeNormalizeImageMime_(contentType) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  return type.indexOf('image/') === 0 ? type : 'image/jpeg';
}

function scheduleIntakeExtForMime_(mimeType) {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic' };
  return map[mimeType] || 'jpg';
}
