/**
 * テスト用ハーネス
 * ------------------------------------------------------------
 * 本番反映(確認ポイント③)の前に、GASエディタから手動実行して動作確認するための関数群です。
 *
 * ・testYukiLogicCases() / testMitsukiLogicCases() / testMitsukiEscortLogicCases()
 *     気象API・カレンダーに依存しない、固定データによるロジック単体テスト。
 *     いつでもすぐに実行でき、判定式(しきい値まわり)の確認に使う。
 * ・testWeatherApiSmoke()
 *     実際にJMA/YOLP/ジオコーディングを呼び出す疎通確認。要YAHOO_APP_ID設定。
 * ・testFullRunDryRun()
 *     実際のカレンダー・気象データを使って本番と同じ処理を1回流す。
 *     WEATHER_DRY_RUN=true(デフォルト)であればLINE送信は行われず、ログに出力されるだけなので安全。
 * ・testFinalNotificationForTomorrow()
 *     「確定版」ロジック(下校時アラートの予約を含む)を、明日を対象日として即座に検証する。
 * ・testDangerWarningSmoke()
 *     気象庁 警報・注意報JSON(危険警報)の生データをログに出す疎通確認・調査用。
 *     判定ロジック(matchesDangerWarning_)がまだ未実装のため、実データを見て確定させるために使う。
 * ------------------------------------------------------------
 */

// ==== ゆうきさんロジックの単体テスト(固定データ、ネットワークアクセス無し。朝の判定のみ) ====
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
  Logger.log('ゆうきさんロジックテスト(朝のみ): ' + okCount + '/' + cases.length + ' 件成功');

  // 朝・帰り往復判定を含むメッセージ文面のサンプル(decideYukiTransport_と同じ形のダミーデータで検証)
  function fakeYukiResult(morningRainy, afternoonRainy) {
    const morning = evaluateRainCondition_(morningRainy ? 60 : 20, [], config);
    const afternoon = evaluateRainCondition_(afternoonRainy ? 60 : 20, [], config);
    return {
      mode: (morning.rainy || afternoon.rainy) ? 'バス' : '自転車',
      morning: morning,
      afternoon: afternoon,
      homewardTime: new Date('2026-08-13T16:00:00+09:00'),
      homewardLabel: '通常下校',
    };
  }
  Logger.log('--- メッセージサンプル(朝晴れ・帰り晴れ→自転車) ---\n' +
    buildYukiMessage_(new Date('2026-08-13T00:00:00+09:00'), fakeYukiResult(false, false), true));
  Logger.log('--- メッセージサンプル(朝雨→バス) ---\n' +
    buildYukiMessage_(new Date('2026-08-13T00:00:00+09:00'), fakeYukiResult(true, false), true));
  Logger.log('--- メッセージサンプル(朝は良好・帰りだけ雨→往復バス、修正1の確認) ---\n' +
    buildYukiMessage_(new Date('2026-08-13T00:00:00+09:00'), fakeYukiResult(false, true), true));
}

// ==== みつきさんロジックの単体テスト(出発時刻のお知らせ。固定データ、ネットワークアクセス無し) ====
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

// ==== みつきさんの送迎提案(項目4・新規)の単体テスト(固定データ、ネットワークアクセス無し) ====
function testMitsukiEscortLogicCases() {
  const config = { popThreshold: 50, rainIntensityThresholdMmh: 1 };
  const goTime = new Date('2026-08-13T16:00:00+09:00');
  const returnTime = new Date('2026-08-13T18:00:00+09:00');

  function fakeEscortResult(goPop, returnPop) {
    const go = evaluateRainCondition_(goPop, [], config);
    const ret = evaluateRainCondition_(returnPop, [], config);
    return {
      label: '卓球部',
      mode: (go.rainy || ret.rainy) ? '送迎' : '徒歩',
      goTime: goTime,
      returnTime: returnTime,
      go: go,
      ret: ret,
    };
  }

  const cases = [
    { name: '行き・帰りとも晴れ→徒歩', goPop: 20, returnPop: 20, expectMode: '徒歩' },
    { name: '行きだけ雨→送迎', goPop: 60, returnPop: 20, expectMode: '送迎' },
    { name: '帰りだけ雨→送迎', goPop: 20, returnPop: 60, expectMode: '送迎' },
  ];
  let okCount = 0;
  cases.forEach(function (c) {
    const r = fakeEscortResult(c.goPop, c.returnPop);
    const pass = r.mode === c.expectMode;
    if (pass) okCount++;
    Logger.log((pass ? '[OK] ' : '[NG] ') + c.name + ' => ' + r.mode);
  });
  Logger.log('みつき送迎提案ロジックテスト: ' + okCount + '/' + cases.length + ' 件成功');

  Logger.log('--- メッセージサンプル(徒歩) ---\n' +
    buildMitsukiEscortMessage_(new Date('2026-08-13T00:00:00+09:00'), fakeEscortResult(20, 20), true));
  Logger.log('--- メッセージサンプル(送迎) ---\n' +
    buildMitsukiEscortMessage_(new Date('2026-08-13T00:00:00+09:00'), fakeEscortResult(60, 20), true));
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

/**
 * 気象庁 警報・注意報JSON(危険警報)の生データを確認する疎通確認・調査用関数。
 * 「危険警報」は判定ロジック(matchesDangerWarning_)が未実装のため、
 * この関数の実行結果(実際のcode値・ステータス表記・その他のフィールド)を見てから
 * WeatherNotify_SafetyAlerts.gsのmatchesDangerWarning_を実装してください。
 */
function testDangerWarningSmoke() {
  let warningJson;
  try {
    warningJson = fetchJmaWarningRaw_();
  } catch (e) {
    Logger.log('[エラー] 警報JSON取得: ' + e.message);
    return;
  }

  const areas = extractMunicipalityWarningAreas_(warningJson);
  Logger.log('=== 市区町村単位areas件数: ' + areas.length + ' ===');

  Logger.log('=== 対象市町村(確認済みコード)の照合結果 ===');
  DANGER_WARNING_MUNICIPALITIES_.forEach(function (muni) {
    muni.codes.forEach(function (code) {
      const area = areas.find(function (a) { return a.code === code; });
      if (!area) {
        Logger.log(muni.label + '(コード' + code + '): 一致するareaが見つかりませんでした。' +
          '下の全件ログから、実際のコードを確認してください。');
      } else {
        Logger.log(muni.label + '(コード' + code + '): ' + JSON.stringify(area));
      }
    });
  });

  Logger.log('=== areas全件(先頭30件、実際のコード・警報一覧確認用) ===');
  areas.slice(0, 30).forEach(function (a) {
    Logger.log(JSON.stringify(a));
  });
  if (areas.length > 30) {
    Logger.log('...他 ' + (areas.length - 30) + '件(省略)');
  }

  Logger.log('=== JSON全体のトップレベル構造(キー一覧) ===');
  Logger.log(Object.keys(warningJson).join(', '));
}

/**
 * 登校日判定(isSchoolDay_)の診断ログ付き実行(要実カレンダー)。
 * 「登校日のはずなのに登校日と判定されない」等の調査用。どの条件で除外されたか、
 * 休み系キーワードに一致した予定があればそのタイトルまでログに出す。
 * 「明日」など相対日付だと実行時刻(特に深夜)によって対象日がずれるため、
 * targetDateの行を直接書き換えて、確認したい日付を指定してください。
 */
function testSchoolDayDiagnostic() {
  const targetDate = new Date('2026-09-04T00:00:00+09:00'); // ここを書き換えれば任意の日付で確認可能
  const calendarId = getConfig_().calendarId;

  ['【ゆうき】', '【みつき】'].forEach(function (namePrefix) {
    const result = isSchoolDay_(targetDate, calendarId, namePrefix, true);
    Logger.log(namePrefix + ' 最終判定: ' + (result ? '登校日' : '登校日ではない'));
    Logger.log('---');
  });
}

/**
 * 下校時刻算出ロジック(項目2)の疎通確認(要実カレンダー)。
 * 「明日」など相対日付だと実行時刻(特に深夜)によって対象日がずれるため、
 * targetDateの行を直接書き換えて、確認したい日付を指定してください。
 */
function testHomewardDepartureSmoke() {
  const targetDate = new Date('2026-09-04T00:00:00+09:00'); // ここを書き換えれば任意の日付で確認可能
  const calendarId = getConfig_().calendarId;
  Logger.log('=== 対象日: ' + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd') + ' ===');

  ['ゆうき', 'みつき'].forEach(function (name) {
    const namePrefix = '【' + name + '】';
    const defaultEnd = name === 'ゆうき' ? getYukiDefaultSchoolEnd_() : getMitsukiDefaultSchoolEnd_();
    const result = getHomewardDepartureTime_(targetDate, calendarId, namePrefix, defaultEnd);
    if (!result) {
      Logger.log(name + ': 対象日は下校予定なし(登校日でもなく、時刻付きの予定も無い)');
    } else {
      Logger.log(name + ': 下校予定 ' + Utilities.formatDate(result.time, 'Asia/Tokyo', 'H:mm') +
        '頃(' + result.source + (result.label ? ' / ' + result.label : '') + ')');
    }
  });
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
 * 「確定版」ロジック(ナウキャストによる雨雲判定・下校時アラートの予約を含む)を、
 * 実際の日付を待たずに検証するための関数。
 * sendFinalNotification()は実行時点の「今日」しか対象にできないため、
 * まだ来ていない日を確定版として試すには、この関数のように対象日を直接指定して呼び出す必要がある。
 * 関数選択プルダウンからすぐ実行できるよう、「明日」を対象にした引数無しラッパーにしている。
 * 別の日で試したい場合は、下のtargetDateの行を書き換えて実行してください
 * (例: new Date('2026-08-25T00:00:00+09:00'))。
 * ※下校時アラートは、対象日の下校予定時刻の30分前(初期値)に実際に使い捨てトリガーが発火して送信される。
 *   「明日」を対象にすると通常は下校予定時刻が翌日になるため、このテスト実行では即座には届かない。
 */
function testFinalNotificationForTomorrow() {
  const targetDate = new Date(new Date().getTime() + 24 * 60 * 60 * 1000); // ここを書き換えれば任意の日付で検証可能
  Logger.log('=== 確定版ロジックを日付指定でテスト: ' +
    Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd') + ' ===');
  runWeatherNotification_(targetDate, true);
}
