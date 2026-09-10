/**
 * 安全情報(危険警報チェック・河川水位情報リンク)
 * ------------------------------------------------------------
 * ■ 危険警報チェック(気象庁 警報・注意報JSON)
 * 2026年5月29日開始の新しい防災気象情報体系(レベル4相当の「危険警報」、例: レベル4大雨危険警報・
 * レベル4土砂災害危険警報)に対応する機能。対象市町村(豊田市・知立市・刈谷市)でレベル4相当の
 * 危険警報が発表されているかを確認し、発表されていれば登校提案メッセージの冒頭に明記する。
 *
 * 【現状のステータス(要検証・暫定実装)】
 * 「危険警報」は2026年5月に始まったばかりの新しい情報体系です。この開発環境からは
 * www.jma.go.jp への直接アクセスができない(ネットワークポリシーでブロック)ため、実際のJSON
 * レスポンスの中でどのフィールド・コード値が「危険警報」を表すのかを確認できていません。
 * まず対象市町村の生データをログに出す疎通確認(testDangerWarningSmoke、WeatherNotify_Test.gs)を
 * 用意したので、GAS上で一度実行し、結果を確認してから判定ロジック(matchesDangerWarning_)を
 * 確定させてください。それまでは、checkDangerWarnings_は常に「該当なし」を返す安全側の暫定実装です
 * (誤って警報を出さないだけで、既存の通知処理を止めたり壊したりすることはありません)。
 *
 * ■ 河川水位情報(逢妻女川・千足橋観測所)へのリンク
 * 当初は国土交通省「川の防災情報」(river.go.jp)から水位・危険度を自動取得する案でしたが、
 * 同サイトの「取り扱い上の注意」ページに「一般利用者が通常のブラウザで閲覧することを想定しており、
 * ツールによる定期的なデータ取得は控えてほしい」という趣旨の記載があったため、サイト側の要望に反する
 * 自動定期取得(GASの日次トリガーによる継続的な取得)は行わないことにした。代わりに、観測所の
 * 個別ページへのリンクをメッセージに載せ、必要な時に人が手動で開いて確認する形にしている。
 * リンク先は愛知県「川の防災情報」(kasen-aichi.jp)の逢妻女川・千足観測所ページ(検索で特定したもので、
 * この開発環境からは直接開いて内容を視覚的に確認できていないため、初回は実際に開いて正しいページか
 * 確認してください)。
 * ------------------------------------------------------------
 */

// 逢妻女川・千足橋観測所(愛知県「川の防災情報」)の個別ページ。自動取得はせず、リンクとしてのみ使用する。
const RIVER_LEVEL_INFO_URL_ = 'https://www.kasen-aichi.jp/WaterLevelIndividual_10_5_7120.html';
const RIVER_LEVEL_INFO_LABEL_ = '逢妻女川(千足)水位情報';

// ==== 河川水位情報のメッセージ行を組み立てる(常に固定のリンクを返す) ====
function buildRiverLevelInfoLine_() {
  return '参考: ' + RIVER_LEVEL_INFO_LABEL_ + ' ' + RIVER_LEVEL_INFO_URL_;
}

const JMA_WARNING_URL_AICHI_ = 'https://www.jma.go.jp/bosai/warning/data/warning/230000.json';

// 対象市町村(警報JSON内の市区町村単位areasのcodeと照合する)。
// コードはJIS地方公共団体コード+"00"という一般的な規則から推定した値で、未検証。
// testDangerWarningSmokeの実行結果で実際のコード・名称と突き合わせてから確定させてください。
const DANGER_WARNING_MUNICIPALITIES_ = [
  { code: '2321100', label: '豊田市' }, // 自宅
  { code: '2322500', label: '知立市' }, // 通学経路
  { code: '2321000', label: '刈谷市' }, // 学校
];

// ==== 気象庁 警報・注意報JSON(愛知県)の生データを取得(数分キャッシュして呼び出し回数を抑える) ====
function fetchJmaWarningRaw_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('jma_warning_230000');
  if (cached) {
    return JSON.parse(cached);
  }
  const response = UrlFetchApp.fetch(JMA_WARNING_URL_AICHI_, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('気象庁警報APIエラー(' + response.getResponseCode() + ')');
  }
  const json = JSON.parse(response.getContentText());
  cache.put('jma_warning_230000', JSON.stringify(json), 10 * 60); // 10分キャッシュ
  return json;
}

// ==== 警報JSONの中から、市区町村単位(areaTypesのうち最も細分化された階層)のareas配列を取り出す ====
function extractMunicipalityWarningAreas_(warningJson) {
  if (!warningJson || !warningJson.areaTypes) return [];
  // 市区町村単位は他の階層よりareas件数が多いため、件数最大のものを採用する
  let best = null;
  warningJson.areaTypes.forEach(function (at) {
    if (at.areas && (!best || at.areas.length > best.areas.length)) {
      best = at;
    }
  });
  return best ? best.areas : [];
}

/**
 * 対象市町村でレベル4相当の危険警報が発表されているか確認する。
 * 【現状は暫定実装】どのcode/フィールドが危険警報を表すか未検証のため、常に空配列を返す
 * (=通知全体には一切影響しない安全側の実装)。testDangerWarningSmokeの結果を見て、
 * matchesDangerWarning_を実装してください。
 * @return {Array<{municipality: string, description: string}>}
 */
function checkDangerWarnings_() {
  const results = [];
  try {
    const warningJson = fetchJmaWarningRaw_();
    const areas = extractMunicipalityWarningAreas_(warningJson);
    DANGER_WARNING_MUNICIPALITIES_.forEach(function (muni) {
      const area = areas.find(function (a) { return a.code === muni.code; });
      if (!area || !area.warnings) return;
      area.warnings.forEach(function (w) {
        const desc = matchesDangerWarning_(w);
        if (desc) {
          results.push({ municipality: muni.label, description: desc });
        }
      });
    });
  } catch (e) {
    Logger.log('危険警報チェックでエラー(通知全体は続行します): ' + e.message);
  }
  return results;
}

/**
 * 個々の警報エントリがレベル4相当の危険警報に該当するか判定する(要実装。現状は常にnull=該当なし)。
 * testDangerWarningSmokeの実行結果(実際のcode値・ステータス表記・その他のフィールド)を見てから、
 * ここに具体的な条件を実装してください。
 * @param {Object} warningEntry 例: { code: '...', status: '...' } (実際のフィールドは要確認)
 * @return {string|null} 該当する場合は「レベル4大雨危険警報」のような表示用の名称、しなければnull
 */
function matchesDangerWarning_(warningEntry) {
  return null; // 暫定: 判定条件が未検証のため常に該当なしとする
}

// ==== 危険警報のメッセージ冒頭行を組み立てる(該当なしならnull) ====
function buildDangerWarningLine_(matches) {
  if (!matches || matches.length === 0) return null;
  const lines = matches.map(function (m) {
    return '【警報】' + m.municipality + 'に' + m.description + 'が発表されています。登校前に最新情報をご確認ください。';
  });
  return lines.join('\n');
}
