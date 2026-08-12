/**
 * ゆうきさん(刈谷高校) バス/自転車判定ロジック
 * ------------------------------------------------------------
 * ・登校日のみ判定対象(土日祝日・長期休み等は対象外)
 * ・降水確率50%以上 → バス推奨
 * ・加えて、自宅/学校/中継地点(名鉄若林駅・知立駅・刈谷市駅)のいずれかで
 *   今後1〜2時間以内に降水強度1mm/h以上の雨雲通過予報があればバス推奨に切替
 *   (この雨雲判定はYOLPナウキャストの性質上、直近1時間程度先までしか予測できないため、
 *    実際に運用するのは登校直前の「当日6:30」通知のみ。前日21:00の暫定版は
 *    降水確率のみで判定する。詳細はREADME参照)
 * ------------------------------------------------------------
 */

const YUKI_COMMUTE_HOUR_ = 7; // 登校時間帯の代表時刻(この時刻のPoPを参照する)

// ==== 対象日がゆうきさんの登校日かどうか判定(共通ロジックはConfig.gsのisSchoolDay_を使用) ====
function isYukiSchoolDay_(date, calendarId) {
  return isSchoolDay_(date, calendarId, '【ゆうき】');
}

/**
 * ゆうきさんのバス/自転車判定を行う(気象APIを実際に呼び出す)。
 * @param {Date} targetDate 登校日(対象日)
 * @param {boolean} useNowcast trueの場合、YOLPナウキャストによる雨雲判定も行う(当日6:30通知用)
 * @return {Object} { mode: 'バス'|'自転車', reasons: string[], pop: number|null }
 */
function decideYukiTransport_(targetDate, useNowcast) {
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const commuteTime = new Date(dateStr + 'T00:00:00');
  commuteTime.setHours(YUKI_COMMUTE_HOUR_, 0, 0, 0);

  let pop = null;
  try {
    pop = getPrecipitationProbabilityAt_(commuteTime);
  } catch (e) {
    Logger.log('降水確率の取得でエラー: ' + e.message);
  }

  const rainSpotDetails = [];
  if (useNowcast) {
    YUKI_ROUTE_CHECK_KEYS_.forEach(function (key) {
      const mmh = getMaxForecastRainfallMmh_(key);
      if (mmh !== null) {
        rainSpotDetails.push({ label: WEATHER_LOCATIONS_[key].label, mmh: mmh });
      }
    });
  }

  return decideYukiTransportFromData_(pop, rainSpotDetails, getWeatherConfig_());
}

/**
 * 気象データ(降水確率・地点ごとの降水強度)からバス/自転車を判定する純粋関数。
 * ネットワークアクセスを行わないため、テストハーネスからモックデータで検証できる。
 * @param {number|null} pop 降水確率(%)。取得できなかった場合はnull
 * @param {Array<{label:string, mmh:number}>} rainSpotDetails 地点ごとの降水強度予測(mm/h)
 * @param {Object} config getWeatherConfig_()の戻り値
 * @return {Object} { mode: 'バス'|'自転車', reasons: string[], pop: number|null }
 */
function decideYukiTransportFromData_(pop, rainSpotDetails, config) {
  const reasons = [];
  let busRecommended = false;

  if (pop !== null) {
    if (pop >= config.popThreshold) {
      busRecommended = true;
      reasons.push('降水確率' + pop + '%(しきい値' + config.popThreshold + '%以上)');
    }
  } else {
    reasons.push('降水確率を取得できませんでした');
  }

  const rainSpots = rainSpotDetails
    .filter(function (spot) { return spot.mmh >= config.rainIntensityThresholdMmh; })
    .map(function (spot) { return spot.label + '(' + spot.mmh + 'mm/h)'; });
  if (rainSpots.length > 0) {
    busRecommended = true;
    reasons.push('今後の雨雲通過予報: ' + rainSpots.join('、'));
  }

  return {
    mode: busRecommended ? 'バス' : '自転車',
    reasons: reasons,
    pop: pop,
  };
}
