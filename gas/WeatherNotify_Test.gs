/**
 * テスト用ハーネス
 * ------------------------------------------------------------
 * 本番反映(確認ポイント③)の前に、GASエディタから手動実行して動作確認するための関数群です。
 *
 * ・testYukiLogicCases() / testMitsukiLogicCases() / testDepartureNoticeEscortCases()
 *     気象API・カレンダーに依存しない、固定データによるロジック単体テスト。
 *     いつでもすぐに実行でき、判定式(しきい値まわり)の確認に使う。
 * ・testWeatherApiSmoke()
 *     実際にJMA/YOLP/ジオコーディングを呼び出す疎通確認。要YAHOO_APP_ID設定。
 * ・testFullRunDryRun()
 *     実際のカレンダー・気象データを使って本番と同じ処理を1回流す。
 *     WEATHER_DRY_RUN=true(デフォルト)であればLINE送信は行われず、ログに出力されるだけなので安全。
 * ・testFinalNotificationForTomorrow()
 *     「確定版」ロジック(帰りの雨雲アラート・車送迎直前アラートの予約を含む)を、明日を対象日として即座に検証する。
 * ・testDangerWarningSmoke()
 *     気象庁 警報・注意報JSON(危険警報)の生データをログに出す疎通確認・調査用。
 *     判定ロジック(matchesDangerWarning_)がまだ未実装のため、実データを見て確定させるために使う。
 * ・testDepartureNoticeDiagnostic()
 *     出発まわりの通知(項目A)の対象抽出・メッセージ文面を、実カレンダーで確認する診断用。
 * ・reportMessageVolumeEstimate()
 *     直近N日分の通知件数を、種類×宛先チャネル×暫定/確定で集計する(項目H)。実カレンダー必須。
 * ・testYukiTravelTimes()
 *     ゆうきさんのTRANSITモード(非登校日部活)で使う移動時間の実機検証用(新規)。直近の土曜・日曜、
 *     朝8:00/9:00到着想定でMapsを実際に呼び出し、directions.status・所要時間・採用している固定値との
 *     差をログに出す。LINE送信は行わない。
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
      homewardTime: new Date('2026-08-13T17:00:00+09:00'),
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

// ==== みつきさんの登校(自転車通学)出発時刻お知らせ(項目B)の単体テスト(固定データ、ネットワークアクセス無し) ====
function testMitsukiLogicCases() {
  // calcBikeDeparture_はmarginMin(第5引数)が必須(項目A3で追加)。以下の3ケースはmarginMinを
  // 渡さない旧仕様のままだった呼び出し不備(テスト側のバグ)を修正し、marginMin=0を明示して
  // 従来どおりの期待値(自転車移動時間+雨天バッファのみ)で検証する。
  const config = { popThreshold: 50, mitsukiRainBufferMin: 10 };
  const startTime = new Date('2026-08-13T09:00:00+09:00');

  const cases = [
    { name: '晴れ・自転車25分→バッファ無し', travelMinutes: 25, pop: 20, marginMin: 0, expectDeparture: '2026-08-13T08:35:00+09:00' },
    { name: '雨天・自転車25分→+10分バッファ', travelMinutes: 25, pop: 80, marginMin: 0, expectDeparture: '2026-08-13T08:25:00+09:00' },
    { name: 'PoP境界値50%→雨天扱い', travelMinutes: 20, pop: 50, marginMin: 0, expectDeparture: '2026-08-13T08:30:00+09:00' },
  ];

  let okCount = 0;
  cases.forEach(function (c) {
    const result = calcBikeDeparture_(startTime, c.travelMinutes, c.pop, config, c.marginMin);
    const expected = new Date(c.expectDeparture);
    const pass = result.departureTime.getTime() === expected.getTime();
    if (pass) okCount++;
    Logger.log((pass ? '[OK] ' : '[NG] ') + c.name + ' => 出発 ' +
      Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm') +
      '(期待値 ' + Utilities.formatDate(expected, 'Asia/Tokyo', 'H:mm') + ')');
  });
  Logger.log('みつきさん登校ロジックテスト: ' + okCount + '/' + cases.length + ' 件成功');

  // 本番の登校(SCHOOL_COMMUTE)経路と同じ引数(marginMin=ARRIVAL_MARGIN_SCHOOL_MIN、雨天バッファは
  // 本番既定値の0)で計算し、雨天(PoP80%)でも出発目安が7:50固定になることを確認する(項目A2)。
  const schoolConfig = { popThreshold: 50, mitsukiRainBufferMin: 0 };
  const schoolStartTime = new Date('2026-08-13T08:15:00+09:00');
  const schoolMarginMin = getArrivalMarginSchoolMin_();
  const schoolBike = calcBikeDeparture_(schoolStartTime, 15, 80, schoolConfig, schoolMarginMin);
  const schoolExpected = new Date('2026-08-13T07:50:00+09:00');
  const schoolPass = schoolBike.departureTime.getTime() === schoolExpected.getTime();
  Logger.log((schoolPass ? '[OK] ' : '[NG] ') +
    '本番既定値相当(雨天バッファ0・登校の余裕' + schoolMarginMin + '分)で雨天でも7:50固定 => 出発 ' +
    Utilities.formatDate(schoolBike.departureTime, 'Asia/Tokyo', 'H:mm') +
    '(期待値 ' + Utilities.formatDate(schoolExpected, 'Asia/Tokyo', 'H:mm') + ')');

  const bike = calcBikeDeparture_(startTime, 25, 80, config, 0);
  const sample = {
    label: '登校(通常授業)', startTime: startTime, departureTime: bike.departureTime,
    travelMinutes: bike.travelMinutes, isRaining: bike.isRaining, bufferMin: bike.bufferMin,
    marginMin: bike.marginMin, pop: bike.pop, usedPop: bike.usedPop,
  };
  Logger.log('--- メッセージサンプル(暫定版・雨天) ---\n' + buildMitsukiSchoolCommuteMessage_(startTime, sample, false));
  Logger.log('--- メッセージサンプル(確定版・雨天) ---\n' + buildMitsukiSchoolCommuteMessage_(startTime, sample, true));
}

// ==== 出発まわりの通知(項目A)の車送迎要否判定(旧・送迎提案)の単体テスト(固定データ、ネットワークアクセス無し) ====
function testDepartureNoticeEscortCases() {
  const config = { popThreshold: 50, mitsukiRainBufferMin: 10, rainIntensityThresholdMmh: 1 };
  const startTime = new Date('2026-08-13T16:00:00+09:00');
  const homeward = { time: new Date('2026-08-13T18:00:00+09:00'), source: 'calendar', label: '卓球部' };
  const target = { label: '卓球部', startTime: startTime, mode: 'BIKE' };

  const cases = [
    { name: '行き・帰りとも晴れ→送迎不要', goPop: 20, returnPop: 20, expectEscort: false },
    { name: '行きだけ雨→送迎検討', goPop: 60, returnPop: 20, expectEscort: true },
    { name: '帰りだけ雨→送迎検討', goPop: 20, returnPop: 60, expectEscort: true },
  ];
  let okCount = 0;
  cases.forEach(function (c) {
    const result = calcDepartureNoticeDetailsFromData_(target, 15, c.goPop, c.returnPop, homeward, config);
    const pass = result.escortNeeded === c.expectEscort;
    if (pass) okCount++;
    Logger.log((pass ? '[OK] ' : '[NG] ') + c.name + ' => escortNeeded=' + result.escortNeeded);
  });
  Logger.log('出発まわりの通知(送迎要否)ロジックテスト: ' + okCount + '/' + cases.length + ' 件成功');

  const bikeResult = calcDepartureNoticeDetailsFromData_(target, 15, 60, 20, homeward, config);
  Logger.log('--- メッセージサンプル(BIKEモード・車送迎検討) ---\n' +
    buildDepartureNoticeMessage_(new Date('2026-08-13T00:00:00+09:00'), 'みつき', bikeResult, true, null));

  const carTarget = {
    label: '英語(塾)',
    startTime: new Date('2026-08-13T18:10:00+09:00'),
    endTime: new Date('2026-08-13T19:30:00+09:00'),
    mode: 'CAR',
  };
  const carResult = calcDepartureNoticeDetailsFromData_(carTarget, null, null, null, homeward, config);
  Logger.log('--- メッセージサンプル(CARモード・英語) ---\n' +
    buildDepartureNoticeMessage_(new Date('2026-08-13T00:00:00+09:00'), 'みつき', carResult, true, null));
  Logger.log('--- メッセージサンプル(暫定版から変更ありの場合) ---\n' +
    buildDepartureNoticeMessage_(new Date('2026-08-13T00:00:00+09:00'), 'みつき', bikeResult, true, '出発目安: 15:35 → 15:20 / 車送迎の検討が必要になりました'));
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
 * 「登校日のはずなのに登校日と判定されない」等の調査用。祝日判定はGoogleの祝日カレンダーを
 * 参照する(項目E)。取得に失敗した場合は静的リスト(JAPAN_HOLIDAYS_)にフォールバックし、
 * その旨がログに出る。休み系キーワードに一致した予定があればそのタイトルまでログに出す。
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
 * 帰り予定時刻算出ロジック(getHomewardDepartureTime_)の疎通確認(要実カレンダー)。
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
    // 英語・お茶(家庭発の予定)は帰り予定時刻の算出対象から除外する(本番と同じ条件)。
    // ゆうきの非登校日の部活(TRANSITモード)は除外しない(項目A1で復元。getHomewardDepartureTime_のdocを参照)
    const excludeLabelKeywords = name === 'ゆうき' ? YUKI_LESSON_NAMES_ : MITSUKI_LESSON_NAMES_;
    const result = getHomewardDepartureTime_(targetDate, calendarId, namePrefix, defaultEnd, excludeLabelKeywords);
    if (!result) {
      Logger.log(name + ': 対象日は帰りの予定なし(登校日でもなく、時刻付きの予定も無い)');
    } else {
      Logger.log(name + ': 帰りの予定 ' + Utilities.formatDate(result.time, 'Asia/Tokyo', 'H:mm') +
        '頃(' + result.source + (result.label ? ' / ' + result.label : '') + ')');
    }
  });
}

/**
 * 出発まわりの通知(統合版。項目A2)の対象抽出・メッセージ文面を、実カレンダーで確認する診断用関数。
 * getDepartureNoticeTargets_の診断ログ([出発まわりの通知診断])に加えて、
 * 実際にdecideYukiDepartureNotices_/decideMitsukiCombinedNotices_/buildCombinedDepartureMessage_に
 * 通した結果(1人1通に統合されたメッセージ文面)を出力する。確定版は暫定版スナップショットが
 * 無い状態での試算のため、差分要約は常に「変更なし」になる点に注意(実際の確定版配信時は
 * 暫定版のスナップショットと比較する。sendCombinedDepartureNotices_参照)。
 * 「明日」など相対日付だと実行時刻(特に深夜)によって対象日がずれるため、
 * targetDateの行を直接書き換えて、確認したい日付を指定してください。
 */
function testDepartureNoticeDiagnostic() {
  const targetDate = new Date('2026-09-14T00:00:00+09:00'); // ここを書き換えれば任意の日付で確認可能
  const calendarId = getConfig_().calendarId;
  Logger.log('=== 対象日: ' + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd') + ' ===');

  [
    { key: 'YUKI', label: 'ゆうき', sections: decideYukiDepartureNotices_(targetDate, calendarId) },
    { key: 'MITSUKI', label: 'みつき', sections: decideMitsukiCombinedNotices_(targetDate, calendarId) },
  ].forEach(function (person) {
    Logger.log(person.label + ': 出発まわりの通知セクション数=' + person.sections.length +
      '(' + person.sections.map(function (s) { return s.label + ':' + s.mode; }).join(', ') + ')');
    if (person.sections.length === 0) {
      Logger.log(person.label + ': 対象が無いため、この日は通知しません(項目A2)。');
      return;
    }
    Logger.log('--- ' + person.label + ' 暫定版メッセージサンプル ---');
    Logger.log(buildCombinedDepartureMessage_(targetDate, person.label, person.sections, false, null));
    Logger.log('--- ' + person.label + ' 確定版メッセージサンプル(暫定版スナップショット無しのため差分は「変更なし」表示) ---');
    Logger.log(buildCombinedDepartureMessage_(targetDate, person.label, person.sections, true, '変更なし'));
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
 * 「確定版」ロジック(ナウキャストによる雨雲判定・帰りの雨雲アラート/車送迎直前アラートの予約を含む)を、
 * 実際の日付を待たずに検証するための関数。
 * sendFinalNotification()は実行時点の「今日」しか対象にできないため、
 * まだ来ていない日を確定版として試すには、この関数のように対象日を直接指定して呼び出す必要がある。
 * 関数選択プルダウンからすぐ実行できるよう、「明日」を対象にした引数無しラッパーにしている。
 * 別の日で試したい場合は、下のtargetDateの行を書き換えて実行してください
 * (例: new Date('2026-08-25T00:00:00+09:00'))。
 * ※帰りの雨雲アラート・車送迎直前アラートは、対象日の帰り予定時刻/予定開始時刻の前に実際に使い捨て
 *   トリガーが発火して送信される。「明日」を対象にすると通常は帰り予定時刻が翌日になるため、
 *   このテスト実行では即座には届かない。
 */
function testFinalNotificationForTomorrow() {
  const targetDate = new Date(new Date().getTime() + 24 * 60 * 60 * 1000); // ここを書き換えれば任意の日付で検証可能
  Logger.log('=== 確定版ロジックを日付指定でテスト: ' +
    Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd') + ' ===');
  runWeatherNotification_(targetDate, true);
}

/**
 * 通知件数の集計(項目H)。
 * startOffsetDaysからdays日分について、実カレンダーを使って通知の対象件数を数え、
 * 「通知の種類×宛先チャネル×暫定/確定」別の通数をログに表形式で出す(実際には送信しない)。
 * WEATHER_DRY_RUNの値に関わらずLINE送信は一切行わない(この関数はsendLinePushMessage_を呼ばない)。
 *
 * 【使い方】今回の変更(項目A〜D)の前後で比較したい場合は、この関数を「変更前のコード」の状態で
 * 一度実行してログを保存し、変更を反映した後にもう一度実行して比較してください
 * (このリポジトリには変更前のロジックを別名で残していません。実際の家族カレンダーに依存する
 * 集計のため、この開発環境からは実行できず、比較にはGAS上で2回実行する形が必要です)。
 *
 * @param {number} [startOffsetDays] 集計開始日(今日からのオフセット日数。既定0=今日から)
 * @param {number} [days] 集計日数(既定30)
 */
function reportMessageVolumeEstimate(startOffsetDays, days) {
  const offset = (startOffsetDays === undefined) ? 0 : startOffsetDays;
  const dayCount = days || 30;
  const config = getWeatherConfig_();
  const calendarId = getConfig_().calendarId;

  // counts[チャネルラベル][通知の種類][暫定|確定] = 件数
  const counts = {};
  function addCount(channelLabel, type, version) {
    if (!channelLabel) return;
    counts[channelLabel] = counts[channelLabel] || {};
    counts[channelLabel][type] = counts[channelLabel][type] || { 暫定: 0, 確定: 0 };
    counts[channelLabel][type][version]++;
  }
  function addForRecipients(recipients, type, version) {
    recipients.forEach(function (r) {
      if (r.userId) addCount(r.channelLabel, type, version);
    });
  }

  for (let i = 0; i < dayCount; i++) {
    const targetDate = new Date(new Date().setHours(0, 0, 0, 0) + (offset + i) * 24 * 60 * 60 * 1000);

    ['暫定', '確定'].forEach(function (version) {
      // ゆうき: 登校 天気予報(既存、変更なし。暫定・確定とも常に送る)
      if (isYukiSchoolDay_(targetDate, calendarId)) {
        addForRecipients(getPersonNotifyRecipients_(config, 'YUKI'), '登校 天気予報(ゆうき)', version);
      }
      // 出発まわりの通知(項目A1・A2で改訂: 1人1通に統合。確定版も「常に送る」ため対象が
      // あれば暫定・確定とも1通ずつとカウントする。みつきは登校(自転車通学)もこの1通に含まれる)
      const yukiDep = decideYukiDepartureNotices_(targetDate, calendarId);
      if (yukiDep.length > 0) {
        addForRecipients(getPersonNotifyRecipients_(config, 'YUKI'), '出発まわりの通知(ゆうき・統合)', version);
      }
      const mitsukiDep = decideMitsukiCombinedNotices_(targetDate, calendarId);
      if (mitsukiDep.length > 0) {
        addForRecipients(getPersonNotifyRecipients_(config, 'MITSUKI'), '出発まわりの通知(みつき・統合)', version);
      }

      mitsukiDep.forEach(function (r) {
        if (version === '確定' && r.mode === 'CAR') {
          addForRecipients(getPersonNotifyRecipients_(config, 'MITSUKI'), '直前アラート(みつき)', version);
          // 項目A4: 迎えの連絡リマインドはみつき本人には送らず、一志さん・きくみさんのみ
          addForRecipients(getPersonNotifyRecipients_(config, 'MITSUKI').slice(1), '迎えの連絡リマインド(みつき)', version);
        }
        if (version === '確定' && r.mode === 'BIKE') {
          // 自転車の出発直前アラートは本人のみ(CCなし)
          addCount(getPersonNotifyRecipients_(config, 'MITSUKI')[0].channelLabel, '自転車の出発直前アラート(みつき)', version);
          // 項目A6: 家庭発の習い事(お茶等)の帰りの雨雲アラート(英語はCARモードのため対象外)
          if (isMitsukiLessonName_(r.label)) {
            addForRecipients(getPersonNotifyRecipients_(config, 'MITSUKI'), '帰りの雨雲アラート・習い事(みつき)', version);
          }
        }
      });
      yukiDep.forEach(function (r) {
        if (version === '確定' && (r.mode === 'CAR' || r.mode === 'TRANSIT')) {
          addForRecipients(getPersonNotifyRecipients_(config, 'YUKI'), '直前アラート(ゆうき)', version);
        }
        if (version === '確定' && r.mode === 'CAR') {
          addForRecipients(getPersonNotifyRecipients_(config, 'YUKI'), '迎えの連絡リマインド(ゆうき)', version);
        }
        if (version === '確定' && r.mode === 'TRANSIT') {
          // 項目A3: 迎えの連絡+帰りの雨雲アラートに統合(CCはYUKI_STATION_NOTICE_CCでオンオフ可能)
          addForRecipients(getYukiStationNoticeRecipients_(config), '迎えの連絡+帰りの雨雲アラート(ゆうき)', version);
        }
        if (version === '確定' && r.mode === 'BIKE') {
          addCount(getPersonNotifyRecipients_(config, 'YUKI')[0].channelLabel, '自転車の出発直前アラート(ゆうき)', version);
        }
      });
      // 帰りの雨雲アラート(確定版配信時のみ予約される。項目A3: ゆうきは登校日のみ対象)
      if (version === '確定') {
        if (isYukiSchoolDay_(targetDate, calendarId)) {
          const yukiHomeward = getHomewardDepartureTime_(targetDate, calendarId, '【ゆうき】', getYukiDefaultSchoolEnd_(), YUKI_LESSON_NAMES_);
          if (yukiHomeward) addForRecipients(getPersonNotifyRecipients_(config, 'YUKI'), '帰りの雨雲アラート(ゆうき)', version);
        }
        const mitsukiHomeward = getHomewardDepartureTime_(targetDate, calendarId, '【みつき】', getMitsukiDefaultSchoolEnd_(), MITSUKI_LESSON_NAMES_);
        if (mitsukiHomeward) addForRecipients(getPersonNotifyRecipients_(config, 'MITSUKI'), '帰りの雨雲アラート(みつき)', version);
      }
    });
  }

  Logger.log('=== 通知件数集計(' + Utilities.formatDate(new Date(new Date().setHours(0, 0, 0, 0) + offset * 24 * 60 * 60 * 1000), 'Asia/Tokyo', 'yyyy-MM-dd') +
    ' から ' + dayCount + '日分。項目A1で確定版の「出発まわりの通知」は常に送るよう変更したため件数として確定的ですが、' +
    '直前アラート・自転車の出発直前アラートは項目A5の抑制ルール(確定版配信時刻の前後60分・仮値以内なら出さない)を' +
    'この集計では考慮していないため、その2種類については上限値です) ===');
  Object.keys(counts).sort().forEach(function (channelLabel) {
    Logger.log('--- ' + channelLabel + ' ---');
    let total = 0;
    Object.keys(counts[channelLabel]).sort().forEach(function (type) {
      const c = counts[channelLabel][type];
      Logger.log('  ' + type + ': 暫定=' + c.暫定 + ' / 確定=' + c.確定 + ' / 小計=' + (c.暫定 + c.確定));
      total += c.暫定 + c.確定;
    });
    const monthlyRate = dayCount > 0 ? Math.round(total / dayCount * 30) : 0;
    Logger.log('  合計: ' + total + '件(' + dayCount + '日間) / 30日換算: 約' + monthlyRate + '件(無料枠200件に対し約' +
      Math.round(monthlyRate / 200 * 100) + '%)');
  });
}

/**
 * 通数集計の代替(項目7)。直近N日分の【ゆうき】【みつき】タグ付き予定を、タイトル・開始/終了時刻・
 * 終日かどうかだけに絞ってJSONでログに出す。実行結果をコピーしてこちらに貼ってもらえれば、
 * Node上で旧ロジック・新ロジックの両方に同じデータを通して通知件数を集計できる
 * (この関数自体は予定の内容をそのままログに出すため、実行結果はリポジトリにコミットしないこと)。
 * @param {number} [startOffsetDays] 収集開始日(今日からのオフセット日数。既定0=今日から)
 * @param {number} [days] 収集日数(既定30)
 */
function exportRecentScheduleForVolumeEstimate(startOffsetDays, days) {
  const offset = (startOffsetDays === undefined) ? 0 : startOffsetDays;
  const dayCount = days || 30;
  const calendarId = getConfig_().calendarId;
  const dayStart = new Date(new Date().setHours(0, 0, 0, 0) + offset * 24 * 60 * 60 * 1000);
  const dayEnd = new Date(dayStart.getTime() + dayCount * 24 * 60 * 60 * 1000);

  const calendar = CalendarApp.getCalendarById(calendarId);
  const events = calendar.getEvents(dayStart, dayEnd);
  const result = events
    .filter(function (ev) {
      return ev.getTitle().indexOf('【ゆうき】') === 0 || ev.getTitle().indexOf('【みつき】') === 0;
    })
    .map(function (ev) {
      return {
        title: ev.getTitle(),
        start: ev.getStartTime().toISOString(),
        end: ev.getEndTime().toISOString(),
        allDay: ev.isAllDayEvent(),
      };
    });

  Logger.log('=== 予定の書き出し(' + Utilities.formatDate(dayStart, 'Asia/Tokyo', 'yyyy-MM-dd') +
    ' から ' + dayCount + '日分、' + result.length + '件。※家族の予定を含むためログの取り扱いに注意) ===');
  Logger.log(JSON.stringify(result));
}

/**
 * ゆうきさんのTRANSITモード(非登校日部活)で使う移動時間の実機検証用(項目E、新規)。
 * 直近の土曜・日曜、朝8:00・9:00到着想定(計4パターン)について、車(自宅→若林駅、DRIVING)・
 * 徒歩(刈谷市駅→刈谷高校、WALKING)・電車(若林駅→刈谷市駅、TRANSIT)を実際にMapsで呼び出し、
 * directions.status・所要時間・採用している固定値(YUKI_CAR_TO_STATION_FALLBACK_MIN等)との
 * 差をログに出す。LINE送信は行わない。土日でダイヤが異なる可能性があるため両方確認する
 * (電車は15分間隔とのユーザー申告があり、平日ダイヤと異なる可能性がある)。
 */
function testYukiTravelTimes() {
  function nextDow_(dow) { // dow: 0=日曜〜6=土曜。今日と同じ曜日なら来週分を返す
    const now = new Date();
    let diff = (dow - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
  }

  const scenarios = [
    { label: '直近の土曜 8:00到着想定', date: nextDow_(6), hour: 8 },
    { label: '直近の土曜 9:00到着想定', date: nextDow_(6), hour: 9 },
    { label: '直近の日曜 8:00到着想定', date: nextDow_(0), hour: 8 },
    { label: '直近の日曜 9:00到着想定', date: nextDow_(0), hour: 9 },
  ];

  const fixedCarMin = getYukiCarToStationFallbackMin_();
  const fixedWalkMin = getYukiWalkFallbackMin_();
  const fixedTrainMin = getYukiTrainMin_();

  function logLeg(label, originAddress, destinationAddress, mode, fixedMin, atTime, note) {
    try {
      const result = fetchDirectionsMinutes_(originAddress, destinationAddress, mode, atTime);
      const diff = result.minutes === null ? '(差: 算出不可)' : '(差: Maps−固定値 = ' + (result.minutes - fixedMin) + '分)';
      Logger.log(label + ': status=' + result.status + ' Maps所要時間=' +
        (result.minutes === null ? '取得不可' : result.minutes + '分') + ' / 採用値(固定)=' + fixedMin + '分 ' + diff +
        (note ? ' ' + note : ''));
    } catch (e) {
      Logger.log(label + ': 取得中にエラー: ' + e.message);
    }
  }

  scenarios.forEach(function (s) {
    const atTime = new Date(s.date.getFullYear(), s.date.getMonth(), s.date.getDate(), s.hour, 0, 0);
    Logger.log('=== ' + s.label + '(' + Utilities.formatDate(atTime, 'Asia/Tokyo', 'yyyy-MM-dd H:mm') + ') ===');
    logLeg('車(自宅→若林駅、DRIVING)', WEATHER_LOCATIONS_.HOME.address, WEATHER_LOCATIONS_.STATION_WAKABAYASHI.address,
      Maps.DirectionFinder.Mode.DRIVING, fixedCarMin, atTime);
    logLeg('徒歩(刈谷市駅→刈谷高校、WALKING)', WEATHER_LOCATIONS_.STATION_KARIYASHI.address, WEATHER_LOCATIONS_.SCHOOL_YUKI.address,
      Maps.DirectionFinder.Mode.WALKING, fixedWalkMin, atTime);
    logLeg('電車(若林駅→刈谷市駅、TRANSIT)', WEATHER_LOCATIONS_.STATION_WAKABAYASHI.address, WEATHER_LOCATIONS_.STATION_KARIYASHI.address,
      Maps.DirectionFinder.Mode.TRANSIT, fixedTrainMin, atTime, '(土日ダイヤは要確認。列車は15分間隔とのユーザー申告あり)');
  });
}
