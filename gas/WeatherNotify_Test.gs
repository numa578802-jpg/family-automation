/**
 * テスト用ハーネス
 * ------------------------------------------------------------
 * 本番反映(確認ポイント③)の前に、GASエディタから手動実行して動作確認するための関数群です。
 *
 * ・testYukiLogicCases() / testMitsukiLogicCases()
 *     気象API・カレンダーに依存しない、固定データによるロジック単体テスト。
 *     いつでもすぐに実行でき、判定式(しきい値まわり)の確認に使う。
 * ・testWeatherApiSmoke()
 *     実際にJMA/YOLP/ジオコーディングを呼び出す疎通確認。要YAHOO_APP_ID設定。
 * ・testFullRunDryRun()
 *     実際のカレンダー・気象データを使って本番と同じ処理を1回流す。
 *     WEATHER_DRY_RUN=true(デフォルト)であればLINE送信は行われず、ログに出力されるだけなので安全。
 * ------------------------------------------------------------
 */

// ==== ゆうきさんロジックの単体テスト(固定データ、ネットワークアクセス無し) ====
function testYukiLogicCases() {
  const config = { popThreshold: 50, rainIntensityThresholdMmh: 1 };
  const cases = [
    { name: 'PoP低・雨雲無し→自転車', pop: 20, rainSpots: [], expectMode: '自転車' },
    { name: 'PoP50%ちょうど→バス(境界値)', pop: 50, rainSpots: [], expectMode: 'バス' },
    { name: 'PoP49%→自転車(境界値)', pop: 49, rainSpots: [], expectMode: '自転車' },
    { name: 'PoP低いが雨雲通過予報あり→バス', pop: 10, rainSpots: [{ label: '自宅', mmh: 2 }], expectMode: 'バス' },
    { name: '雨雲強度がしきい値未満→自転車', pop: 10, rainSpots: [{ label: '自宅', mmh: 0.5 }], expectMode: '自転車' },
    { name: 'PoP取得失敗(null)かつ雨雲無し→自転車', pop: null, rainSpots: [], expectMode: '自転車' },
  ];

  let okCount = 0;
  cases.forEach(function (c) {
    const result = decideYukiTransportFromData_(c.pop, c.rainSpots, config);
    const pass = result.mode === c.expectMode;
    if (pass) okCount++;
    Logger.log((pass ? '[OK] ' : '[NG] ') + c.name + ' => ' + result.mode + ' / 理由: ' + result.reasons.join(' / '));
  });
  Logger.log('ゆうきさんロジックテスト: ' + okCount + '/' + cases.length + ' 件成功');

  // メッセージ文面のサンプルも出力しておく
  const sample = decideYukiTransportFromData_(60, [{ label: '刈谷市駅', mmh: 2 }], config);
  Logger.log('--- メッセージサンプル(暫定版) ---\n' + buildYukiMessage_(new Date(), sample, false));
  Logger.log('--- メッセージサンプル(確定版) ---\n' + buildYukiMessage_(new Date(), sample, true));
}

// ==== みつきさんロジックの単体テスト(固定データ、ネットワークアクセス無し) ====
function testMitsukiLogicCases() {
  const config = { popThreshold: 50, mitsukiRainBufferMin: 10 };
  const startTime = new Date('2026-08-13T09:00:00+09:00');

  const cases = [
    { name: '晴れ・自転車25分→バッファ無し', travelMinutes: 25, pop: 20, expectDeparture: '2026-08-13T08:35:00+09:00' },
    { name: '雨天・自転車25分→+10分バッファ', travelMinutes: 25, pop: 80, expectDeparture: '2026-08-13T08:25:00+09:00' },
    { name: 'PoP境界値50%→雨天扱い', travelMinutes: 20, pop: 50, expectDeparture: '2026-08-13T08:30:00+09:00' },
  ];

  let okCount = 0;
  cases.forEach(function (c) {
    const result = calcMitsukiDeparture_('テスト予定', startTime, c.travelMinutes, c.pop, config);
    const expected = new Date(c.expectDeparture);
    const pass = result.departureTime.getTime() === expected.getTime();
    if (pass) okCount++;
    Logger.log((pass ? '[OK] ' : '[NG] ') + c.name + ' => 出発 ' +
      Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm') +
      '(期待値 ' + Utilities.formatDate(expected, 'Asia/Tokyo', 'H:mm') + ')');
  });
  Logger.log('みつきさんロジックテスト: ' + okCount + '/' + cases.length + ' 件成功');

  const sample = calcMitsukiDeparture_('卓球部練習', startTime, 25, 80, config);
  Logger.log('--- メッセージサンプル(暫定版) ---\n' + buildMitsukiMessage_(startTime, sample, false));
  Logger.log('--- メッセージサンプル(確定版) ---\n' + buildMitsukiMessage_(startTime, sample, true));
}

// ==== 実際の外部API疎通確認(要YAHOO_APP_ID/ネットワーク) ====
function testWeatherApiSmoke() {
  Logger.log('=== ジオコーディング確認 ===');
  Object.keys(WEATHER_LOCATIONS_).forEach(function (key) {
    try {
      const latLng = getLocationLatLng_(key);
      Logger.log(WEATHER_LOCATIONS_[key].label + ': ' + JSON.stringify(latLng));
    } catch (e) {
      Logger.log('[エラー] ' + WEATHER_LOCATIONS_[key].label + ': ' + e.message);
    }
  });

  Logger.log('=== 降水確率(明日朝7時)確認 ===');
  const tomorrow7am = new Date();
  tomorrow7am.setDate(tomorrow7am.getDate() + 1);
  tomorrow7am.setHours(7, 0, 0, 0);
  try {
    const pop = getPrecipitationProbabilityAt_(tomorrow7am);
    Logger.log('降水確率: ' + pop + '%');
  } catch (e) {
    Logger.log('[エラー] 降水確率取得: ' + e.message);
  }

  Logger.log('=== YOLPナウキャスト(自宅)確認 ===');
  const mmh = getMaxForecastRainfallMmh_('HOME');
  Logger.log('自宅の降水強度予測最大値: ' + mmh + ' mm/h');

  Logger.log('=== 自転車移動時間(自宅→前林中学校)確認 ===');
  const minutes = getBikingTravelMinutes_(WEATHER_LOCATIONS_.HOME.address, WEATHER_LOCATIONS_.SCHOOL_MITSUKI.address);
  Logger.log('自転車移動時間: ' + minutes + '分');
}

// ==== 本番と同じ処理を1回流す(WEATHER_DRY_RUN=trueならLINE送信されずログのみ) ====
function testFullRunDryRun() {
  const config = getWeatherConfig_();
  Logger.log('DRY_RUN=' + config.dryRun + '(falseの場合、実際にLINEへ送信されるので注意してください)');
  Logger.log('=== 暫定版(前日21時想定)のテスト実行 ===');
  sendProvisionalNotification();
  Logger.log('=== 確定版(当日6:30想定)のテスト実行 ===');
  sendFinalNotification();
}

/**
 * 「確定版」ロジック(ナウキャストによる雨雲判定を含む)を、実際の日付を待たずに検証するための関数。
 * sendFinalNotification()は実行時点の「今日」を対象にする作りのため、まだ来ていない日を
 * 確定版として試すには、この関数のように対象日を直接指定して呼び出す必要がある。
 * 関数選択プルダウンからすぐ実行できるよう、「明日」を対象にした引数無しラッパーにしている。
 * 別の日で試したい場合は、下のtargetDateの行を書き換えて実行してください
 * (例: new Date('2026-08-25T00:00:00+09:00'))。
 */
function testFinalNotificationForTomorrow() {
  const targetDate = new Date(new Date().getTime() + 24 * 60 * 60 * 1000); // ここを書き換えれば任意の日付で検証可能
  Logger.log('=== 確定版ロジックを日付指定でテスト: ' +
    Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd') + ' ===');
  runWeatherNotification_(targetDate, true);
}
