/**
 * みつきさん(前林中学校) 出発時刻リマインドロジック
 * ------------------------------------------------------------
 * ・その日に時刻付きの【みつき】予定(部活・習い事等、カレンダーに登録されているもの)が1件以上あれば、
 *   それぞれについて個別に「家を出るべき時刻」を算出し、1件ずつ「出発時刻のお知らせ」を送る
 *   (例: 朝の登校とは別に、下校後いったん帰宅してから夕方の英語(塾)へ改めて出発する日は、
 *   朝の分・夕方の分の2件が届く)。
 * ・時刻付きの予定がその日に1件も無い場合は、登校日であれば通常授業の登校時刻
 *   (MITSUKI_DEFAULT_SCHOOL_START、確定値)を基準に1件だけ算出する。
 * ・移動時間はGASのMapsサービスで自宅→目的地(予定のlocationが未設定なら学校)の自転車移動時間を取得
 *   (みつきさんは自転車通学のため)。
 * ・雨天時(降水確率がしきい値以上)は移動バッファ+10分(初期値)を加算する。
 * ------------------------------------------------------------
 */

// 通常授業日の標準登校時刻(確定値)
const MITSUKI_DEFAULT_SCHOOL_START_PROP_ = 'MITSUKI_DEFAULT_SCHOOL_START';
const MITSUKI_DEFAULT_SCHOOL_START_FALLBACK_ = '08:15';

function getMitsukiDefaultSchoolStart_() {
  return PropertiesService.getScriptProperties().getProperty(MITSUKI_DEFAULT_SCHOOL_START_PROP_) ||
    MITSUKI_DEFAULT_SCHOOL_START_FALLBACK_;
}

// 通常下校時刻(要確認・調整。実際の下校時刻に合わせて後で修正してください)
const MITSUKI_DEFAULT_SCHOOL_END_PROP_ = 'MITSUKI_DEFAULT_SCHOOL_END';
const MITSUKI_DEFAULT_SCHOOL_END_FALLBACK_ = '16:00';

function getMitsukiDefaultSchoolEnd_() {
  return PropertiesService.getScriptProperties().getProperty(MITSUKI_DEFAULT_SCHOOL_END_PROP_) ||
    MITSUKI_DEFAULT_SCHOOL_END_FALLBACK_;
}

// ==== 対象日がみつきさんの登校日かどうか判定(共通ロジックはConfig.gsのisSchoolDay_を使用) ====
function isMitsukiSchoolDay_(date, calendarId) {
  return isSchoolDay_(date, calendarId, '【みつき】');
}

// ==== 対象日の「基準となる予定」一覧(時刻付き【みつき】予定それぞれ、無ければ通常登校1件)を取得 ====
function getMitsukiTargetEvents_(targetDate, calendarId) {
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const calendar = CalendarApp.getCalendarById(calendarId);
  const events = calendar.getEvents(dayStart, dayEnd);
  const timedMitsukiEvents = events.filter(function (ev) {
    return ev.getTitle().indexOf('【みつき】') === 0 && !ev.isAllDayEvent();
  });
  timedMitsukiEvents.sort(function (a, b) { return a.getStartTime() - b.getStartTime(); });

  if (timedMitsukiEvents.length > 0) {
    return timedMitsukiEvents.map(function (ev) {
      return {
        label: ev.getTitle().replace('【みつき】', ''),
        startTime: ev.getStartTime(),
        destinationAddress: ev.getLocation() || WEATHER_LOCATIONS_.SCHOOL_MITSUKI.address,
      };
    });
  }

  if (isMitsukiSchoolDay_(targetDate, calendarId)) {
    const startTime = new Date(dateStr + 'T' + getMitsukiDefaultSchoolStart_() + ':00');
    return [{
      label: '登校(通常授業)',
      startTime: startTime,
      destinationAddress: WEATHER_LOCATIONS_.SCHOOL_MITSUKI.address,
    }];
  }

  return []; // その日はリマインド対象の予定なし
}

/**
 * みつきさんの出発時刻リマインドを、対象予定ごとに算出する(気象API・Mapsを実際に呼び出す)。
 * @return {Array<Object>} calcMitsukiDeparture_の戻り値の配列。対象予定が無い日は空配列。
 */
function decideMitsukiReminders_(targetDate, calendarId) {
  const targets = getMitsukiTargetEvents_(targetDate, calendarId);
  const config = getWeatherConfig_();
  return targets.map(function (target) {
    const travelMinutes = getBikingTravelMinutes_(WEATHER_LOCATIONS_.HOME.address, target.destinationAddress);

    let pop = null;
    try {
      pop = getPrecipitationProbabilityAt_(target.startTime);
    } catch (e) {
      Logger.log('降水確率の取得でエラー(みつき): ' + e.message);
    }

    return calcMitsukiDeparture_(target.label, target.startTime, travelMinutes, pop, config);
  });
}

/**
 * 予定開始時刻・移動時間・降水確率から出発時刻を算出する純粋関数。
 * ネットワークアクセスを行わないため、テストハーネスからモックデータで検証できる。
 */
function calcMitsukiDeparture_(label, startTime, travelMinutes, pop, config) {
  const isRaining = pop !== null && pop >= config.popThreshold;
  const bufferMin = isRaining ? config.mitsukiRainBufferMin : 0;
  const departureTime = new Date(startTime.getTime() - (travelMinutes + bufferMin) * 60 * 1000);

  return {
    label: label,
    startTime: startTime,
    departureTime: departureTime,
    travelMinutes: travelMinutes,
    isRaining: isRaining,
    bufferMin: bufferMin,
    pop: pop,
    usedPop: pop !== null,
  };
}

// ==== 対象の予定が「部活動」または「お茶」に該当するか(送迎提案の対象判定用) ====
function isMitsukiActivityRelevant_(title) {
  return title.indexOf('部') !== -1 || title.indexOf('お茶') !== -1;
}

/**
 * みつきさんの部活動/お茶の日に、行き・帰りの雨天状況から「徒歩」「送迎」を提案する(新規機能)。
 * 対象日に部活動/お茶の時刻付き予定が無ければnullを返す(その日は送迎提案の対象外)。
 * 行き・帰りとも、時間的に離れていることが多いため降水確率のみで判定する(ナウキャストは使わない)。
 * @return {Object|null} { label, mode: '徒歩'|'送迎', goTime, returnTime, go: {...}, ret: {...} }
 */
function decideMitsukiEscort_(targetDate, calendarId) {
  const config = getWeatherConfig_();
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const calendar = CalendarApp.getCalendarById(calendarId);
  const events = calendar.getEvents(dayStart, dayEnd);
  const relevantEvents = events.filter(function (ev) {
    return ev.getTitle().indexOf('【みつき】') === 0 && !ev.isAllDayEvent() && isMitsukiActivityRelevant_(ev.getTitle());
  });
  if (relevantEvents.length === 0) return null; // 部活動/お茶の予定が無い日は対象外

  relevantEvents.sort(function (a, b) { return a.getStartTime() - b.getStartTime(); });
  const target = relevantEvents[0];
  const label = target.getTitle().replace('【みつき】', '');
  const goTime = target.getStartTime();

  const homeward = getHomewardDepartureTime_(targetDate, calendarId, '【みつき】', getMitsukiDefaultSchoolEnd_());
  const returnTime = homeward ? homeward.time : target.getEndTime();

  let goPop = null;
  try {
    goPop = getPrecipitationProbabilityAt_(goTime);
  } catch (e) {
    Logger.log('降水確率の取得でエラー(みつき送迎・行き): ' + e.message);
  }
  const go = evaluateRainCondition_(goPop, [], config);

  let returnPop = null;
  try {
    returnPop = getPrecipitationProbabilityAt_(returnTime);
  } catch (e) {
    Logger.log('降水確率の取得でエラー(みつき送迎・帰り): ' + e.message);
  }
  const ret = evaluateRainCondition_(returnPop, [], config);

  const escortNeeded = go.rainy || ret.rainy;

  return {
    label: label,
    mode: escortNeeded ? '送迎' : '徒歩',
    goTime: goTime,
    returnTime: returnTime,
    go: go,
    ret: ret,
  };
}
