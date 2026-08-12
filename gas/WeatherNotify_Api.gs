/**
 * 天気×カレンダー通知機能 - 気象データ・地点情報の取得
 * ------------------------------------------------------------
 * ・降水確率(PoP)  … 気象庁 天気予報JSON(認証不要)
 *     https://www.jma.go.jp/bin/forecast/data/forecast/230000.json (愛知県)
 * ・降水ナウキャスト(強度・今後の雨雲) … Yahoo! YOLP気象情報API(要アプリケーションID、無料)
 *     https://map.yahooapis.jp/weather/V1/place
 * ------------------------------------------------------------
 */

const JMA_FORECAST_URL_AICHI_ = 'https://www.jma.go.jp/bin/forecast/data/forecast/230000.json';
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
 * 徒歩での移動時間(分)を取得。取得できない場合はMITSUKI_DEFAULT_TRAVEL_MINにフォールバックする。
 */
function getWalkingTravelMinutes_(originAddress, destinationAddress) {
  try {
    const directions = Maps.newDirectionFinder()
      .setOrigin(originAddress)
      .setDestination(destinationAddress)
      .setMode(Maps.DirectionFinder.Mode.WALKING)
      .getDirections();
    if (directions.status === 'OK' && directions.routes && directions.routes.length > 0) {
      const durationSec = directions.routes[0].legs[0].duration.value;
      return Math.ceil(durationSec / 60);
    }
    Logger.log('徒歩移動時間の取得に失敗(status: ' + (directions && directions.status) + ')。デフォルト値を使用します。');
  } catch (e) {
    Logger.log('徒歩移動時間の取得中にエラー: ' + e.message + ' デフォルト値を使用します。');
  }
  return getWeatherConfig_().mitsukiDefaultTravelMin;
}
