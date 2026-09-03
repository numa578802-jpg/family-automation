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

// 通常下校時刻(要確認・調整。実際の下校時刻に合わせて後で修正してください)
const YUKI_DEFAULT_SCHOOL_END_PROP_ = 'YUKI_DEFAULT_SCHOOL_END';
const YUKI_DEFAULT_SCHOOL_END_FALLBACK_ = '16:00';

function getYukiDefaultSchoolEnd_() {
  return PropertiesService.getScriptProperties().getProperty(YUKI_DEFAULT_SCHOOL_END_PROP_) ||
    YUKI_DEFAULT_SCHOOL_END_FALLBACK_;
}

// ==== 対象日がゆうきさんの登校日かどうか判定(共通ロジックはConfig.gsのisSchoolDay_を使用) ====
function isYukiSchoolDay_(date, calendarId) {
  return isSchoolDay_(date, calendarId, '【ゆうき】');
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
  const homeward = getHomewardDepartureTime_(targetDate, calendarId, '【ゆうき】', getYukiDefaultSchoolEnd_());
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
