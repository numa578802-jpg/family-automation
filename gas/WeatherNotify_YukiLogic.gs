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
 * ゆうきさんの非登校日部活(TRANSITモード、項目A2・今回改訂=項目A)の経路:
 *   行き: 自宅 →(車)若林駅 →(電車)刈谷市駅 →(徒歩)刈谷高校
 *   帰り: 刈谷高校 →(徒歩)刈谷市駅 →(電車)若林駅 →(車で迎え)自宅
 *
 * 家を出る目安 = 開始時刻
 *   − 徒歩(刈谷市駅→刈谷高校、YUKI_WALK_FALLBACK_MIN)
 *   − 徒歩の余裕(YUKI_WALK_MARGIN_MIN)
 *   − 電車(若林駅→刈谷市駅、YUKI_TRAIN_MIN)
 *   − 若林駅の余裕(YUKI_STATION_BUFFER_MIN。車→電車の乗り継ぎのため)
 *   − 車(自宅→若林駅、YUKI_CAR_TO_STATION_FALLBACK_MIN)
 *   − 車の余裕(YUKI_CAR_MARGIN_MIN)
 *
 * 帰り(迎えの連絡+帰りの雨雲アラート。項目A3で統合、WeatherNotify_Main.gsのscheduleYukiStationNotices_):
 *   部活終了のYUKI_STATION_NOTICE_LEAD_MIN分前に、5地点の雨雲情報と「学校を出てから若林駅までは
 *   YUKI_STATION_ARRIVAL_MIN_MIN〜YUKI_STATION_ARRIVAL_MAX_MIN分ほどかかる見込みです」という
 *   固定の目安レンジを案内する(以前あったcalcYukiStationArrivalEstimate_による分単位の逆算は、
 *   この統合に伴い廃止した)。
 *
 * 2026/9/21(月)朝のGoogleマップ・Yahoo!乗換案内での実地検索値(ユーザー確認済み):
 *   若林駅→刈谷市駅: 26分(知立で乗換1回、待ち含む。列車は15分間隔)
 *   刈谷市駅→刈谷高校: 徒歩7分(500m)
 *   自宅→若林駅: 車25分(ユーザー申告)
 * これらの検索値をYUKI_TRAIN_MIN/YUKI_WALK_FALLBACK_MIN/YUKI_CAR_TO_STATION_FALLBACK_MINの
 * 既定値として採用した。採用する値は常にこれらの固定値(スクリプトプロパティ)を優先し、
 * Mapsの実測値は比較のためログに出すのみで、計算には使わない方針に変更した(calcYukiTransitDetails_参照)。
 * その後、testYukiTravelTimes()による実機のMaps検証(TRANSITモード、status=OK)で電車の所要時間が
 * 28分程度と確認できたため、YUKI_TRAIN_MINの既定値を26→28分に更新した(車25分は変更なし)。
 */
// 車(自宅→若林駅)の所要時間(分)。ユーザー申告値=25分。固定値として採用する(Mapsの結果はログ比較のみ)
const YUKI_CAR_TO_STATION_FALLBACK_MIN_PROP_ = 'YUKI_CAR_TO_STATION_FALLBACK_MIN';
const YUKI_CAR_TO_STATION_FALLBACK_MIN_FALLBACK_ = 25;

function getYukiCarToStationFallbackMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_CAR_TO_STATION_FALLBACK_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_CAR_TO_STATION_FALLBACK_MIN_FALLBACK_;
}

// 車の余裕(分、仮値、新設)。駐車・乗降等の余裕
const YUKI_CAR_MARGIN_MIN_PROP_ = 'YUKI_CAR_MARGIN_MIN';
const YUKI_CAR_MARGIN_MIN_FALLBACK_ = 5;

function getYukiCarMarginMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_CAR_MARGIN_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_CAR_MARGIN_MIN_FALLBACK_;
}

// 徒歩(刈谷市駅→刈谷高校)の所要時間(分)。2026/9/21朝の実地検索値=7分(500m)を既定値として採用
const YUKI_WALK_FALLBACK_MIN_PROP_ = 'YUKI_WALK_FALLBACK_MIN';
const YUKI_WALK_FALLBACK_MIN_FALLBACK_ = 7;

function getYukiWalkFallbackMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_WALK_FALLBACK_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_WALK_FALLBACK_MIN_FALLBACK_;
}

// 徒歩の余裕(分、仮値、新設)
const YUKI_WALK_MARGIN_MIN_PROP_ = 'YUKI_WALK_MARGIN_MIN';
const YUKI_WALK_MARGIN_MIN_FALLBACK_ = 5;

function getYukiWalkMarginMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_WALK_MARGIN_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_WALK_MARGIN_MIN_FALLBACK_;
}

// 電車(若林駅→刈谷市駅)の所要時間(分)。実機のMaps検証(testYukiTravelTimes、TRANSITモード)で
// 28分程度(status=OK)が確認できたため、既定値として28分を採用(ユーザー決定)
const YUKI_TRAIN_MIN_PROP_ = 'YUKI_TRAIN_MIN';
const YUKI_TRAIN_MIN_FALLBACK_ = 28;

function getYukiTrainMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_TRAIN_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_TRAIN_MIN_FALLBACK_;
}

// 若林駅の余裕(分、仮値)。車を降りて電車に乗るまでの乗り継ぎ余裕。列車が15分間隔のため10分に変更
const YUKI_STATION_BUFFER_MIN_PROP_ = 'YUKI_STATION_BUFFER_MIN';
const YUKI_STATION_BUFFER_MIN_FALLBACK_ = 10;

function getYukiStationBufferMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(YUKI_STATION_BUFFER_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : YUKI_STATION_BUFFER_MIN_FALLBACK_;
}

/**
 * TRANSITモードの出発目安を算出する純粋関数(区間ごとの移動時間・余裕の合計を開始時刻から引くだけ)。
 * ネットワークアクセスを行わないため、テストハーネスからモックデータで検証できる。
 */
function calcYukiTransitDepartureFromData_(startTime, carMin, carMarginMin, trainMin, stationBufferMin, walkMin, walkMarginMin) {
  const totalMin = carMin + carMarginMin + trainMin + stationBufferMin + walkMin + walkMarginMin;
  const departureTime = new Date(startTime.getTime() - totalMin * 60 * 1000);
  return {
    departureTime: departureTime,
    carMin: carMin,
    carMarginMin: carMarginMin,
    trainMin: trainMin,
    stationBufferMin: stationBufferMin,
    walkMin: walkMin,
    walkMarginMin: walkMarginMin,
    totalMin: totalMin,
  };
}

/**
 * ゆうきさんの非登校日部活(TRANSITモード、項目A2)1件分の詳細を算出する(気象APIを実際に呼び出す)。
 * 実際のデータ取得を行い、純粋関数calcYukiTransitDepartureFromData_に渡すだけの薄いラッパー
 * (calcDepartureNoticeDetails_のTRANSIT版。CAR/BIKEと違いConfig.gs側では扱わず、
 * ゆうきさん専用のためこのファイルに置く)。
 * 今回の改訂: 採用する値は固定値(スクリプトプロパティ)を優先する方針に変更した。Mapsは
 * 比較用の参考値としてのみ呼び出し、結果をログに出すが、計算には使わない
 * (logYukiTravelTimeMapsComparison_参照。理由: Mapsの結果は取得タイミングやリアルタイム交通状況で
 * 変動しうる一方、通知の再現性・予測可能性を優先し、実地検索で確認した固定値を使う方針とした)。
 * @param {Object} target getDepartureNoticeTargets_の要素({label, startTime, endTime, mode:'TRANSIT'})
 * @return {Object} label, mode, startTime, endTime, departureTime, carMin, carMarginMin, trainMin,
 *   stationBufferMin, walkMin, walkMarginMin, pop
 */
function calcYukiTransitDetails_(target) {
  const carMin = getYukiCarToStationFallbackMin_();
  const carMarginMin = getYukiCarMarginMin_();
  const trainMin = getYukiTrainMin_();
  const stationBufferMin = getYukiStationBufferMin_();
  const walkMin = getYukiWalkFallbackMin_();
  const walkMarginMin = getYukiWalkMarginMin_();

  logYukiTravelTimeMapsComparison_(carMin, trainMin, walkMin);

  const base = calcYukiTransitDepartureFromData_(target.startTime, carMin, carMarginMin, trainMin, stationBufferMin, walkMin, walkMarginMin);

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
    carMarginMin: carMarginMin,
    trainMin: trainMin,
    stationBufferMin: stationBufferMin,
    walkMin: walkMin,
    walkMarginMin: walkMarginMin,
    pop: pop,
    usedPop: pop !== null,
  };
}

/**
 * Mapsの実測値を、採用している固定値と比較してログに出すだけの関数(項目A: 「採用する値は固定値を
 * 優先する。Mapsの結果は併記ログに出す」)。戻り値は計算には使わない。Maps呼び出しに失敗しても
 * 通知処理自体は止めない(try/catchで個別に握りつぶし、失敗した区間だけ「取得失敗」とログに出す)。
 */
function logYukiTravelTimeMapsComparison_(fixedCarMin, fixedTrainMin, fixedWalkMin) {
  try {
    const mapsCarMin = getDrivingTravelMinutes_(WEATHER_LOCATIONS_.HOME.address, WEATHER_LOCATIONS_.STATION_WAKABAYASHI.address, null);
    Logger.log('[TRANSIT・Maps比較] 車(自宅→若林駅): Maps=' + (mapsCarMin === null ? '取得失敗' : mapsCarMin + '分') +
      ' / 採用(固定値YUKI_CAR_TO_STATION_FALLBACK_MIN)=' + fixedCarMin + '分');
  } catch (e) {
    Logger.log('[TRANSIT・Maps比較] 車(自宅→若林駅)の取得中にエラー: ' + e.message);
  }
  try {
    const mapsTrainMin = getTransitTravelMinutes_(WEATHER_LOCATIONS_.STATION_WAKABAYASHI.address, WEATHER_LOCATIONS_.STATION_KARIYASHI.address, null);
    Logger.log('[TRANSIT・Maps比較] 電車(若林駅→刈谷市駅): Maps=' + (mapsTrainMin === null ? '取得失敗' : mapsTrainMin + '分') +
      ' / 採用(固定値YUKI_TRAIN_MIN)=' + fixedTrainMin + '分');
  } catch (e) {
    Logger.log('[TRANSIT・Maps比較] 電車(若林駅→刈谷市駅)の取得中にエラー: ' + e.message);
  }
  try {
    const mapsWalkMin = getWalkingTravelMinutes_(WEATHER_LOCATIONS_.STATION_KARIYASHI.address, WEATHER_LOCATIONS_.SCHOOL_YUKI.address, null);
    Logger.log('[TRANSIT・Maps比較] 徒歩(刈谷市駅→刈谷高校): Maps=' + (mapsWalkMin === null ? '取得失敗' : mapsWalkMin + '分') +
      ' / 採用(固定値YUKI_WALK_FALLBACK_MIN)=' + fixedWalkMin + '分');
  } catch (e) {
    Logger.log('[TRANSIT・Maps比較] 徒歩(刈谷市駅→刈谷高校)の取得中にエラー: ' + e.message);
  }
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
