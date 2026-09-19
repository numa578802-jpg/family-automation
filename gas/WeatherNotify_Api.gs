/**
 * 天気×カレンダー通知機能 - 気象データ・地点情報の取得
 * ------------------------------------------------------------
 * ・降水確率(PoP)  … 気象庁 天気予報JSON(認証不要)
 *     https://www.jma.go.jp/bosai/forecast/data/forecast/230000.json (愛知県)
 * ・降水ナウキャスト(強度・今後の雨雲) … Yahoo! YOLP気象情報API(要アプリケーションID、無料)
 *     https://map.yahooapis.jp/weather/V1/place
 * ------------------------------------------------------------
 */

const JMA_FORECAST_URL_AICHI_ = 'https://www.jma.go.jp/bosai/forecast/data/forecast/230000.json';
const YOLP_WEATHER_URL_ = 'https://map.yahooapis.jp/weather/V1/place';

// ==== 住所→緯度経度(初回のみジオコーディングし、スクリプトプロパティに永続キャッシュ) ====
function getLocationLatLng_(locationKey) {
  const props = PropertiesService.getScriptProperties();
  const cacheKey = 'GEO_CACHE_' + locationKey;
  const cached = props.getProperty(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const location = WEATHER_LOCATIONS_[locationKey];
  if (!location) {
    throw new Error('未定義の地点キー: ' + locationKey);
  }

  const geocoder = Maps.newGeocoder().setRegion('jp');
  const response = geocoder.geocode(location.address);
  if (!response || response.status !== 'OK' || !response.results || response.results.length === 0) {
    throw new Error('ジオコーディングに失敗しました(' + location.label + ' / ' + location.address + '): ' +
      (response ? response.status : 'no response'));
  }

  const latLng = response.results[0].geometry.location; // {lat, lng}
  props.setProperty(cacheKey, JSON.stringify(latLng));
  Logger.log(location.label + ' の座標を取得しキャッシュしました: ' + JSON.stringify(latLng));
  return latLng;
}

// ==== 気象庁 予報JSON(愛知県)の生データを取得(数分キャッシュして呼び出し回数を抑える) ====
function fetchJmaForecastRaw_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('jma_forecast_230000');
  if (cached) {
    return JSON.parse(cached);
  }
  const response = UrlFetchApp.fetch(JMA_FORECAST_URL_AICHI_, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('気象庁予報APIエラー(' + response.getResponseCode() + ')');
  }
  const json = JSON.parse(response.getContentText());
  cache.put('jma_forecast_230000', JSON.stringify(json), 20 * 60); // 20分キャッシュ
  return json;
}

// ==== pops(降水確率)を含むtimeSeriesの中から、対象エリア(西部=豊田市・刈谷市を含む)のpops配列を取得 ====
function extractAichiWestPops_(jmaJson) {
  // jmaJson[0] が短期予報(今日〜3日先)。timeSeriesの中でareas[].popsを持つ要素を探す。
  const forecast = jmaJson[0];
  for (let i = 0; i < forecast.timeSeries.length; i++) {
    const series = forecast.timeSeries[i];
    const areas = series.areas || [];
    if (areas.length > 0 && areas[0].pops) {
      // 「西部」(尾張・知多・西三河=豊田市/刈谷市を含む)を優先。見つからなければ先頭を使う。
      let target = areas.find(function (a) {
        return a.area && a.area.name && a.area.name.indexOf('西部') !== -1;
      });
      if (!target) target = areas[0];
      return { timeDefines: series.timeDefines, pops: target.pops, areaName: target.area ? target.area.name : '' };
    }
  }
  return null;
}

/**
 * 指定した時刻(targetDate: JSTのDateオブジェクト)を含む6時間区分の降水確率(%)を返す。
 * 該当区分が見つからない、または値が空欄(データ無し)の場合はnullを返す。
 */
function getPrecipitationProbabilityAt_(targetDate) {
  const jmaJson = fetchJmaForecastRaw_();
  const popData = extractAichiWestPops_(jmaJson);
  if (!popData) {
    Logger.log('気象庁予報JSONからpops(降水確率)を抽出できませんでした。');
    return null;
  }

  const defines = popData.timeDefines.map(function (d) { return new Date(d); });
  let matchedIndex = -1;
  for (let i = 0; i < defines.length; i++) {
    const windowStart = defines[i];
    const windowEnd = i + 1 < defines.length ? defines[i + 1] : new Date(defines[i].getTime() + 6 * 60 * 60 * 1000);
    if (targetDate >= windowStart && targetDate < windowEnd) {
      matchedIndex = i;
      break;
    }
  }
  if (matchedIndex === -1) {
    Logger.log('対象時刻(' + targetDate + ')に対応する降水確率の区分が見つかりませんでした(エリア: ' + popData.areaName + ')。');
    return null;
  }
  const raw = popData.pops[matchedIndex];
  if (raw === '' || raw === undefined || raw === null) return null;
  return Number(raw);
}

/**
 * 指定地点の、現在時刻から先の降水強度予測(mm/h)の最大値を返す。
 * YOLPナウキャストは直近60分程度先までの予測が上限のため、
 * 「今後1〜2時間以内」の判定については取得できる最大限の予測期間で代用する(既知の制約)。
 * YAHOO_APP_ID未設定、またはAPI呼び出し失敗時はnullを返す(呼び出し側でPoP判定のみにフォールバック)。
 */
function getMaxForecastRainfallMmh_(locationKey) {
  const config = getWeatherConfig_();
  if (!config.yahooAppId) {
    Logger.log('YAHOO_APP_ID未設定のため、ナウキャスト判定をスキップします。');
    return null;
  }

  try {
    const latLng = getLocationLatLng_(locationKey);
    const url = YOLP_WEATHER_URL_ + '?coordinates=' + latLng.lng + ',' + latLng.lat +
      '&appid=' + encodeURIComponent(config.yahooAppId) + '&output=json';
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log('YOLP気象情報APIエラー(' + WEATHER_LOCATIONS_[locationKey].label + ' / ' + response.getResponseCode() + '): ' +
        response.getContentText());
      return null;
    }
    const json = JSON.parse(response.getContentText());
    const feature = json.Feature && json.Feature[0];
    const weatherList = feature && feature.Property && feature.Property.WeatherList && feature.Property.WeatherList.Weather;
    if (!weatherList) return null;

    let maxRainfall = 0;
    weatherList.forEach(function (w) {
      if (w.Type === 'forecast' && typeof w.Rainfall === 'number') {
        maxRainfall = Math.max(maxRainfall, w.Rainfall);
      }
    });
    return maxRainfall;
  } catch (e) {
    Logger.log('ナウキャスト取得中にエラー(' + WEATHER_LOCATIONS_[locationKey].label + '): ' + e.message);
    return null;
  }
}

/**
 * 自転車移動時間(分)を取得(みつきさんは自転車通学のため)。取得できない場合はMITSUKI_DEFAULT_TRAVEL_MINにフォールバックする。
 */
function getBikingTravelMinutes_(originAddress, destinationAddress) {
  try {
    const directions = Maps.newDirectionFinder()
      .setOrigin(originAddress)
      .setDestination(destinationAddress)
      .setMode(Maps.DirectionFinder.Mode.BICYCLING)
      .getDirections();
    if (directions.status === 'OK' && directions.routes && directions.routes.length > 0) {
      const durationSec = directions.routes[0].legs[0].duration.value;
      return Math.ceil(durationSec / 60);
    }
    Logger.log('自転車移動時間の取得に失敗(status: ' + (directions && directions.status) + ')。デフォルト値を使用します。');
  } catch (e) {
    Logger.log('自転車移動時間の取得中にエラー: ' + e.message + ' デフォルト値を使用します。');
  }
  return getWeatherConfig_().mitsukiDefaultTravelMin;
}

/**
 * Maps.newDirectionFinder()を呼び出し、生のdirections結果と所要時間(分)を返す共通ヘルパー。
 * atTimeを渡すとDirectionFinder#setDepart(atTime)でその時刻発を指定する(TRANSITモードで
 * 実際の時刻表に基づく結果を得るために使う。項目E)。省略時は指定なし(=呼び出し時点が基準になる)。
 * @return {{status:string, minutes:number|null}}
 */
function fetchDirectionsMinutes_(originAddress, destinationAddress, mode, atTime) {
  const finder = Maps.newDirectionFinder()
    .setOrigin(originAddress)
    .setDestination(destinationAddress)
    .setMode(mode);
  if (atTime) finder.setDepart(atTime);
  const directions = finder.getDirections();
  const ok = directions && directions.status === 'OK' && directions.routes && directions.routes.length > 0;
  return {
    status: directions && directions.status,
    minutes: ok ? Math.ceil(directions.routes[0].legs[0].duration.value / 60) : null,
  };
}

/**
 * 車移動時間(分)を取得(項目A2: ゆうきさんの非登校日部活、自宅→若林駅の区間で使用)。
 * 取得できない場合はfallbackMinutesを返す(nullを渡すと、失敗時はnullを返す=比較ログ専用に使える)。
 */
function getDrivingTravelMinutes_(originAddress, destinationAddress, fallbackMinutes, atTime) {
  try {
    const result = fetchDirectionsMinutes_(originAddress, destinationAddress, Maps.DirectionFinder.Mode.DRIVING, atTime);
    if (result.minutes !== null) return result.minutes;
    Logger.log('車移動時間の取得に失敗(status: ' + result.status + ')。フォールバック値(' + fallbackMinutes + '分)を使用します。');
  } catch (e) {
    Logger.log('車移動時間の取得中にエラー: ' + e.message + ' フォールバック値(' + fallbackMinutes + '分)を使用します。');
  }
  return fallbackMinutes;
}

/**
 * 徒歩移動時間(分)を取得(項目A2: ゆうきさんの非登校日部活、刈谷市駅→刈谷高校の区間で使用)。
 * 取得できない場合はfallbackMinutesを返す(nullを渡すと、失敗時はnullを返す=比較ログ専用に使える)。
 */
function getWalkingTravelMinutes_(originAddress, destinationAddress, fallbackMinutes, atTime) {
  try {
    const result = fetchDirectionsMinutes_(originAddress, destinationAddress, Maps.DirectionFinder.Mode.WALKING, atTime);
    if (result.minutes !== null) return result.minutes;
    Logger.log('徒歩移動時間の取得に失敗(status: ' + result.status + ')。フォールバック値(' + fallbackMinutes + '分)を使用します。');
  } catch (e) {
    Logger.log('徒歩移動時間の取得中にエラー: ' + e.message + ' フォールバック値(' + fallbackMinutes + '分)を使用します。');
  }
  return fallbackMinutes;
}

/**
 * 電車移動時間(分)を取得(項目A2: ゆうきさんの非登校日部活、若林駅→刈谷市駅の区間で使用)。
 * MapsのTRANSITモードでの取得可否は、このプロジェクトの開発サンドボックスでは実行できず未検証
 * (Maps.newDirectionFinder自体がGAS実行時のみ利用可能なサービスのため)。取得できない場合、
 * またはエラー時はfallbackMinutes(通常はYUKI_TRAIN_MINスクリプトプロパティの値)を返す
 * (nullを渡すと、失敗時はnullを返す=比較ログ専用に使える)。
 * 実際にGAS上で実行し、directions.statusをログで確認して検証すること(testYukiTravelTimes参照)。
 */
function getTransitTravelMinutes_(originAddress, destinationAddress, fallbackMinutes, atTime) {
  try {
    const result = fetchDirectionsMinutes_(originAddress, destinationAddress, Maps.DirectionFinder.Mode.TRANSIT, atTime);
    if (result.minutes !== null) {
      Logger.log('電車移動時間(TRANSIT)の取得に成功しました: ' + result.minutes + '分(status: ' + result.status + ')。');
      return result.minutes;
    }
    Logger.log('電車移動時間(TRANSIT)の取得に失敗(status: ' + result.status + ')。固定値(YUKI_TRAIN_MIN=' + fallbackMinutes + '分)を使用します。');
  } catch (e) {
    Logger.log('電車移動時間(TRANSIT)の取得中にエラー: ' + e.message + ' 固定値(YUKI_TRAIN_MIN=' + fallbackMinutes + '分)を使用します。');
  }
  return fallbackMinutes;
}
