/**
 * ゆうきさん(刈谷高校) バス/自転車判定ロジック
 * ------------------------------------------------------------
 * ・登校日のみ判定対象(土日祝日・長期休み等は対象外)
 * ・朝(登校)・帰り(下校)それぞれについて、降水確率50%以上でバス推奨。
 *   加えて、自宅/学校/中継地点(名鉄若林駅・知立駅・刈谷市駅)のいずれかで
 *   今後1〜2時間以内に降水強度1mm/h以上の雨雲通過予報があればバス推奨に切替
 *   (この雨雲判定はYOLPナウキャストの性質上、直近1時間程度先までしか予測できないため、
 *    実際に運用するのは登校直前の「当日6:30」通知の朝判定のみ。前日21:00の暫定版、
 *    および帰り(下校)の判定は、時間的に離れすぎているため降水確率のみで判定する)
 * ・朝・帰りのどちらか一方でも雨天条件を満たせば、往復ともバス推奨とする
 *   (行きは自転車・帰りだけバス、のような中途半端な提案は避ける)。
 * ------------------------------------------------------------
 */

const YUKI_COMMUTE_HOUR_ = 7; // 登校時間帯の代表時刻(この時刻のPoPを参照する)

// 通常下校時刻(部活が無い日の下校時刻。確認済みの値)
const YUKI_DEFAULT_SCHOOL_END_PROP_ = 'YUKI_DEFAULT_SCHOOL_END';
const YUKI_DEFAULT_SCHOOL_END_FALLBACK_ = '17:00';

function getYukiDefaultSchoolEnd_() {
  return PropertiesService.getScriptProperties().getProperty(YUKI_DEFAULT_SCHOOL_END_PROP_) ||
    YUKI_DEFAULT_SCHOOL_END_FALLBACK_;
}

// ==== 対象日がゆうきさんの登校日かどうか判定(共通ロジックはConfig.gsのisSchoolDay_を使用) ====
function isYukiSchoolDay_(date, calendarId) {
  return isSchoolDay_(date, calendarId, '【ゆうき】');
}

// 家族プロフィール上、ゆうきさんに該当する「家から向かう習い事」は現状無いため空配列。
// 該当するものが出てきた場合はここにキーワードを追加する(みつきさんのMITSUKI_LESSON_NAMES_と同じ考え方)。
const YUKI_LESSON_NAMES_ = [];

/**
 * ゆうきさんの非登校日部活(TRANSITモード、項目A2)の経路:
 *   自宅 →(車)若林駅 →(電車)刈谷市駅 →(徒歩)刈谷高校
 * 家を出る目安 = 開始時刻 − 徒歩(刈谷市駅→刈谷高校) − 電車(若林駅→刈谷市駅) − 車(自宅→若林駅) − 駅での余裕
 */
// 車(自宅→若林駅)の移動時間が取得できない場合のフォールバック値(分。ユーザー申告値=25分)
const YUKI_CAR_TO_STATION_FALLBACK_MIN_PROP_ = 'YUKI_CAR_TO_STATION_FALLBACK_MIN';
const YUKI_CAR_TO_STATION_FALLBACK_MIN_FALLBACK_ = 25;

function getYukiCarToStationFallbackMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_CAR_TO_STATION_FALLBACK_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_CAR_TO_STATION_FALLBACK_MIN_FALLBACK_;
}

// 徒歩(刈谷市駅→刈谷高校)の移動時間が取得できない場合のフォールバック値(分、仮値)
const YUKI_WALK_FALLBACK_MIN_PROP_ = 'YUKI_WALK_FALLBACK_MIN';
const YUKI_WALK_FALLBACK_MIN_FALLBACK_ = 10;

function getYukiWalkFallbackMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_WALK_FALLBACK_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_WALK_FALLBACK_MIN_FALLBACK_;
}

// 電車(若林駅→刈谷市駅)の移動時間(分、仮値)。MapsのTRANSIT取得を試み、失敗時のフォールバックとして使う
const YUKI_TRAIN_MIN_PROP_ = 'YUKI_TRAIN_MIN';
const YUKI_TRAIN_MIN_FALLBACK_ = 10;

function getYukiTrainMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_TRAIN_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_TRAIN_MIN_FALLBACK_;
}

// 駅での乗り換え・待ち時間等の余裕(分、仮値)
const YUKI_STATION_BUFFER_MIN_PROP_ = 'YUKI_STATION_BUFFER_MIN';
const YUKI_STATION_BUFFER_MIN_FALLBACK_ = 5;

function getYukiStationBufferMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_STATION_BUFFER_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_STATION_BUFFER_MIN_FALLBACK_;
}

/**
 * TRANSITモードの出発目安を算出する純粋関数(区間ごとの移動時間の合計を開始時刻から引くだけ)。
 * ネットワークアクセスを行わないため、テストハーネスからモックデータで検証できる。
 */
function calcYukiTransitDepartureFromData_(startTime, carMin, trainMin, walkMin, stationBufferMin) {
  const totalMin = carMin + trainMin + walkMin + stationBufferMin;
  const departureTime = new Date(startTime.getTime() - totalMin * 60 * 1000);
  return {
    departureTime: departureTime,
    carMin: carMin,
    trainMin: trainMin,
    walkMin: walkMin,
    stationBufferMin: stationBufferMin,
    totalMin: totalMin,
  };
}

/**
 * ゆうきさんの非登校日部活(TRANSITモード、項目A2)1件分の詳細を算出する(気象API・Mapsを実際に呼び出す)。
 * 実際のデータ取得を行い、純粋関数calcYukiTransitDepartureFromData_に渡すだけの薄いラッパー
 * (calcDepartureNoticeDetails_のTRANSIT版。CAR/BIKEと違いConfig.gs側では扱わず、
 * ゆうきさん専用のためこのファイルに置く)。
 * @param {Object} target getDepartureNoticeTargets_の要素({label, startTime, endTime, mode:'TRANSIT'})
 * @return {Object} label, mode, startTime, endTime, departureTime, carMin, trainMin, walkMin, stationBufferMin, pop
 */
function calcYukiTransitDetails_(target) {
  const carMin = getDrivingTravelMinutes_(WEATHER_LOCATIONS_.HOME.address, WEATHER_LOCATIONS_.STATION_WAKABAYASHI.address,
    getYukiCarToStationFallbackMin_());
  const trainMin = getTransitTravelMinutes_(WEATHER_LOCATIONS_.STATION_WAKABAYASHI.address, WEATHER_LOCATIONS_.STATION_KARIYASHI.address,
    getYukiTrainMin_());
  const walkMin = getWalkingTravelMinutes_(WEATHER_LOCATIONS_.STATION_KARIYASHI.address, WEATHER_LOCATIONS_.SCHOOL_YUKI.address,
    getYukiWalkFallbackMin_());
  const stationBufferMin = getYukiStationBufferMin_();
  const base = calcYukiTransitDepartureFromData_(target.startTime, carMin, trainMin, walkMin, stationBufferMin);

  let pop = null;
  try {
    pop = getPrecipitationProbabilityAt_(target.startTime);
  } catch (e) {
    Logger.log('降水確率の取得でエラー(ゆうき・出発まわりの通知TRANSIT・' + target.label + '): ' + e.message);
  }

  return {
    label: target.label,
    mode: 'TRANSIT',
    startTime: target.startTime,
    endTime: target.endTime,
    departureTime: base.departureTime,
    carMin: carMin,
    trainMin: trainMin,
    walkMin: walkMin,
    stationBufferMin: stationBufferMin,
    pop: pop,
    usedPop: pop !== null,
  };
}

/**
 * ゆうきさんのバス/自転車判定を行う(気象APIを実際に呼び出す)。朝・帰り両方を判定する。
 * @param {Date} targetDate 登校日(対象日)
 * @param {boolean} useNowcast trueの場合、朝の判定にYOLPナウキャストによる雨雲判定も行う(当日6:30通知用)
 * @param {string} calendarId 家族共有カレンダーのID(下校時刻の算出に使用)
 * @return {Object} { mode: 'バス'|'自転車', morning: {...}, afternoon: {...}, homewardTime: Date|null, homewardLabel: string|null }
 */
function decideYukiTransport_(targetDate, useNowcast, calendarId) {
  const config = getWeatherConfig_();
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');

  // 朝(登校)
  const commuteTime = new Date(dateStr + 'T00:00:00');
  commuteTime.setHours(YUKI_COMMUTE_HOUR_, 0, 0, 0);
  let morningPop = null;
  try {
    morningPop = getPrecipitationProbabilityAt_(commuteTime);
  } catch (e) {
    Logger.log('降水確率の取得でエラー(ゆうき・朝): ' + e.message);
  }
  const morningRainSpots = [];
  if (useNowcast) {
    YUKI_ROUTE_CHECK_KEYS_.forEach(function (key) {
      const mmh = getMaxForecastRainfallMmh_(key);
      if (mmh !== null) {
        morningRainSpots.push({ label: WEATHER_LOCATIONS_[key].label, mmh: mmh });
      }
    });
  }
  const morning = evaluateRainCondition_(morningPop, morningRainSpots, config);

  // 帰り(下校)。時間的に離れているためナウキャストは使わず、降水確率のみで判定する。
  const homeward = getHomewardDepartureTime_(targetDate, calendarId, '【ゆうき】', getYukiDefaultSchoolEnd_(), YUKI_LESSON_NAMES_);
  let afternoon = { rainy: false, reasons: [], pop: null, usedPop: false, usedNowcast: false };
  let homewardTime = null;
  let homewardLabel = null;
  if (homeward) {
    homewardTime = homeward.time;
    homewardLabel = homeward.label;
    let afternoonPop = null;
    try {
      afternoonPop = getPrecipitationProbabilityAt_(homewardTime);
    } catch (e) {
      Logger.log('降水確率の取得でエラー(ゆうき・帰り): ' + e.message);
    }
    afternoon = evaluateRainCondition_(afternoonPop, [], config);
  }

  const busRecommended = morning.rainy || afternoon.rainy;

  return {
    mode: busRecommended ? 'バス' : '自転車',
    morning: morning,
    afternoon: afternoon,
    homewardTime: homewardTime,
    homewardLabel: homewardLabel,
  };
}

/**
 * 気象データ(降水確率・地点ごとの降水強度)からバス/自転車を判定する純粋関数(朝の判定のみ、単体テスト用)。
 * ネットワークアクセスを行わないため、テストハーネスからモックデータで検証できる。
 * @param {number|null} pop 降水確率(%)。取得できなかった場合はnull
 * @param {Array<{label:string, mmh:number}>} rainSpotDetails 地点ごとの降水強度予測(mm/h)
 * @param {Object} config getWeatherConfig_()の戻り値
 * @return {Object} { mode: 'バス'|'自転車', reasons: string[], pop: number|null, usedPop: boolean, usedNowcast: boolean }
 */
function decideYukiTransportFromData_(pop, rainSpotDetails, config) {
  const r = evaluateRainCondition_(pop, rainSpotDetails, config);
  return {
    mode: r.rainy ? 'バス' : '自転車',
    reasons: r.reasons,
    pop: r.pop,
    usedPop: r.usedPop,
    usedNowcast: r.usedNowcast,
  };
}

/**
 * ゆうきさんの「出発まわりの通知」(項目A)対象を算出する(気象API・Mapsを実際に呼び出す)。
 * 非登校日の時刻付き予定(部活等)が対象で、TRANSITモード(項目A2)になる
 * (自宅→(車)若林駅→(電車)刈谷市駅→(徒歩)学校。calcYukiTransitDetails_参照)。
 * 登校日はYUKI_LESSON_NAMES_が空のため対象が無い(=このまま常に空配列を返す。将来、
 * 家から向かう習い事が増えた場合はYUKI_LESSON_NAMES_に追加する。その場合はBIKEモードになる)。
 * @return {Array<Object>} calcDepartureNoticeDetails_/calcYukiTransitDetails_の戻り値の配列。対象予定が無い日は空配列。
 */
function decideYukiDepartureNotices_(targetDate, calendarId) {
  const isSchool = isYukiSchoolDay_(targetDate, calendarId);
  const targets = getDepartureNoticeTargets_(targetDate, calendarId, '【ゆうき】', isSchool,
    YUKI_LESSON_NAMES_, WEATHER_LOCATIONS_.SCHOOL_YUKI.address, 'YUKI');
  if (targets.length === 0) return [];

  const config = getWeatherConfig_();
  const homeward = getHomewardDepartureTime_(targetDate, calendarId, '【ゆうき】', getYukiDefaultSchoolEnd_(), YUKI_LESSON_NAMES_);
  return targets.map(function (target) {
    if (target.mode === 'TRANSIT') {
      return calcYukiTransitDetails_(target);
    }
    return calcDepartureNoticeDetails_(target, WEATHER_LOCATIONS_.HOME.address, homeward, config);
  });
}
