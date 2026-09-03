/**
 * 天気×カレンダー通知機能 - 設定
 * ------------------------------------------------------------
 * 既存の「家族スケジュール自動登録.gs」に追加する機能です。
 * このファイルは地点情報・しきい値など、運用しながら調整する値をまとめています。
 *
 * ■ 追加で必要なスクリプトプロパティ
 *   LINE_CHANNEL_ACCESS_TOKEN … LINE Messaging APIのチャネルアクセストークン(長期)
 *   LINE_CHANNEL_SECRET       … LINE Messaging APIのChannel secret(Webhook署名検証用)
 *   YAHOO_APP_ID              … Yahoo!デベロッパーネットワークで発行するアプリケーションID(YOLP用)
 *
 * ■ 任意のスクリプトプロパティ(未設定なら下記デフォルト値を使用。運用しながら調整可能)
 *   WEATHER_DRY_RUN                    … "true"ならLINE送信せずログ出力のみ(本番反映前のテスト用。デフォルトtrue)
 *   LINE_USER_ID_YUKI / LINE_USER_ID_MITSUKI
 *                                      … 友だち追加時にWebhookで自動登録されるが、手動で設定してもよい
 *   LINE_USER_ID_KAZUSHI / LINE_USER_ID_KIKUMI
 *                                      … 一志さん・きくみさんのuserId(CC受信用)。未取得の間は空欄のままでよく、
 *                                        値を設定するだけで配信対象に加わる(コード変更不要)。
 *                                        ゆうきさん向け・みつきさん向け、それぞれの通知が同一内容で2通届く。
 *   YUKI_POP_THRESHOLD                 … バス推奨とする降水確率(%)のしきい値(デフォルト50)
 *   YUKI_RAIN_INTENSITY_THRESHOLD_MMH  … バス推奨とする雨雲の降水強度しきい値(mm/h、デフォルト1)
 *   MITSUKI_RAIN_BUFFER_MIN            … 雨天時に追加する移動バッファ(分、デフォルト10)
 *   MITSUKI_DEFAULT_TRAVEL_MIN         … 自転車移動時間が取得できない場合のフォールバック値(分、デフォルト15)
 *   YUKI_DEFAULT_SCHOOL_END            … ゆうきさんの通常下校時刻(デフォルト16:00、仮値。要確認)
 *   MITSUKI_DEFAULT_SCHOOL_END         … みつきさんの通常下校時刻(デフォルト16:00、仮値。要確認)
 *   HOMEWARD_ALERT_LEAD_MIN            … 「下校時 雨雲通過予報」を下校予定時刻の何分前に送るか(デフォルト30)
 * ------------------------------------------------------------
 */

// ==== 天気情報の出典URL(全メッセージ共通。判定に実際に使ったデータ種別に応じて付記する) ====
const WEATHER_SOURCE_URL_POP_ = 'https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=230000';
const WEATHER_SOURCE_URL_NOWCAST_ = 'https://weather.yahoo.co.jp/weather/zoomradar/';

// ==== 地点情報(住所ベース。実行時にジオコーディングして緯度経度に変換しキャッシュする) ====
const WEATHER_LOCATIONS_ = {
  HOME: { key: 'HOME', label: '自宅', address: '愛知県豊田市堤町平松' },
  SCHOOL_YUKI: { key: 'SCHOOL_YUKI', label: '刈谷高校', address: '愛知県刈谷市寿町5-101 愛知県立刈谷高等学校' },
  SCHOOL_MITSUKI: { key: 'SCHOOL_MITSUKI', label: '前林中学校', address: '愛知県豊田市前林町行田60 豊田市立前林中学校' },
  // 中継地点はゆうきさんの登校判定(バス/自転車)にのみ使用
  STATION_WAKABAYASHI: { key: 'STATION_WAKABAYASHI', label: '名鉄若林駅', address: '愛知県豊田市若林東町 名鉄三河線 若林駅' },
  STATION_CHIRYU: { key: 'STATION_CHIRYU', label: '知立駅', address: '愛知県知立市 知立駅' },
  STATION_KARIYASHI: { key: 'STATION_KARIYASHI', label: '刈谷市駅', address: '愛知県刈谷市 名鉄三河線 刈谷市駅' },
};

// ゆうきさんの登校経路上、雨雲判定の対象にする地点(自宅・学校・中継地点)
const YUKI_ROUTE_CHECK_KEYS_ = [
  'HOME',
  'SCHOOL_YUKI',
  'STATION_WAKABAYASHI',
  'STATION_CHIRYU',
  'STATION_KARIYASHI',
];

// ==== 設定値の読み込み(数値・フラグ系のみ。既存のgetConfig_とは独立させ、既存ファイルへの影響を避ける) ====
function getWeatherConfig_() {
  const props = PropertiesService.getScriptProperties();
  const numOr = function (value, fallback) {
    const n = Number(value);
    return value && !isNaN(n) ? n : fallback;
  };
  return {
    lineChannelAccessToken: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '',
    lineChannelSecret: props.getProperty('LINE_CHANNEL_SECRET') || '',
    yahooAppId: props.getProperty('YAHOO_APP_ID') || '',
    dryRun: (props.getProperty('WEATHER_DRY_RUN') || 'true') === 'true',
    lineUserIdYuki: props.getProperty('LINE_USER_ID_YUKI') || '',
    lineUserIdMitsuki: props.getProperty('LINE_USER_ID_MITSUKI') || '',
    lineUserIdKazushi: props.getProperty('LINE_USER_ID_KAZUSHI') || '',
    lineUserIdKikumi: props.getProperty('LINE_USER_ID_KIKUMI') || '',
    popThreshold: numOr(props.getProperty('YUKI_POP_THRESHOLD'), 50),
    rainIntensityThresholdMmh: numOr(props.getProperty('YUKI_RAIN_INTENSITY_THRESHOLD_MMH'), 1),
    mitsukiRainBufferMin: numOr(props.getProperty('MITSUKI_RAIN_BUFFER_MIN'), 10),
    mitsukiDefaultTravelMin: numOr(props.getProperty('MITSUKI_DEFAULT_TRAVEL_MIN'), 15),
    homewardAlertLeadMin: numOr(props.getProperty('HOMEWARD_ALERT_LEAD_MIN'), 30),
  };
}

// ==== 家族カレンダー上で「学校が休みと分かる」予定に含まれるキーワード(登校日判定用) ====
// 【ゆうき】/【みつき】タグの予定にこれらのキーワードを含む終日予定がある日は登校日としない。
// 定期試験・文化祭などは登校日のままにするため、ここには含めない。運用しながら調整可能。
const NON_SCHOOL_DAY_KEYWORDS_ = [
  '夏休み', '冬休み', '春休み', '休校', '学校閉庁日', '創立記念日', '振替休日',
];

// ==== 対象日が指定した家族(namePrefix: '【ゆうき】' or '【みつき】')の登校日か判定 ====
// 平日 かつ 国民の祝日でない かつ カレンダー上に長期休み等を示す終日予定が無いこと、を条件とする。
function isSchoolDay_(date, calendarId, namePrefix) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false; // 土日

  const dateStr = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
  const holidayMap = buildHolidayNameMap_(); // 既存スクリプト(家族スケジュール自動登録.gs)の関数を再利用
  if (holidayMap[dateStr]) return false; // 国民の祝日

  try {
    const calendar = CalendarApp.getCalendarById(calendarId);
    const dayStart = new Date(dateStr + 'T00:00:00');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const events = calendar.getEvents(dayStart, dayEnd);
    const hasNonSchoolDayEvent = events.some(function (ev) {
      const title = ev.getTitle();
      if (title.indexOf(namePrefix) !== 0) return false;
      return NON_SCHOOL_DAY_KEYWORDS_.some(function (kw) {
        return title.indexOf(kw) !== -1;
      });
    });
    if (hasNonSchoolDayEvent) return false;
  } catch (e) {
    Logger.log('登校日判定中のカレンダー確認でエラー(判定は続行): ' + e.message);
  }

  return true;
}

/**
 * 降水確率・雨雲通過予報(地点ごとの降水強度)から「雨天と判断すべきか」を判定する共通の純粋関数。
 * ゆうきさんのバス/自転車判定・みつきさんの送迎判定など、複数の判定で共用する
 * (ネットワークアクセスを行わないため、テストハーネスからモックデータで検証できる)。
 * @param {number|null} pop 降水確率(%)。取得できなかった場合はnull
 * @param {Array<{label:string, mmh:number}>} rainSpotDetails 地点ごとの降水強度予測(mm/h)。
 *   ナウキャストを確認していない場合は空配列を渡す(「雨雲なし」と断定しないため)。
 * @param {Object} config getWeatherConfig_()の戻り値(popThreshold, rainIntensityThresholdMmhを使用)
 * @return {Object} { rainy: boolean, reasons: string[], pop: number|null, usedPop: boolean, usedNowcast: boolean }
 */
function evaluateRainCondition_(pop, rainSpotDetails, config) {
  const reasons = [];
  let rainy = false;

  if (pop !== null) {
    if (pop >= config.popThreshold) {
      rainy = true;
      reasons.push('降水確率' + pop + '%(しきい値' + config.popThreshold + '%以上)');
    } else {
      reasons.push('降水確率' + pop + '%(しきい値' + config.popThreshold + '%未満)');
    }
  } else {
    reasons.push('降水確率を取得できませんでした');
  }

  const overThresholdSpots = rainSpotDetails.filter(function (spot) { return spot.mmh >= config.rainIntensityThresholdMmh; });
  if (overThresholdSpots.length > 0) {
    rainy = true;
    const rainSpots = overThresholdSpots.map(function (spot) { return spot.label + '(' + spot.mmh + 'mm/h)'; });
    reasons.push('今後の雨雲通過予報: ' + rainSpots.join('、'));
  } else if (rainSpotDetails.length > 0) {
    // ナウキャストを実際に確認した(=rainSpotDetailsが空でない)がしきい値以上の地点が無かった場合のみ明記する。
    reasons.push('雨雲通過予報なし');
  }

  return {
    rainy: rainy,
    reasons: reasons,
    pop: pop,
    usedPop: pop !== null,
    usedNowcast: rainSpotDetails.length > 0,
  };
}

/**
 * 対象日の「学校(または活動場所)から家に向かって出発する時刻」を、ゆうき・みつき共通で算出する。
 * ルール:
 *   1. 対象日に時刻付きの【namePrefix】予定(部活動・習い事等)があれば、最も遅く終わる予定の終了時刻を候補にする。
 *   2. 対象日が登校日であれば、defaultTimeStr(通常の下校時刻)も候補にする。
 *   3. 候補が複数ある場合は、より遅い時刻(＝より現実的に家へ向かう時刻)を採用する。
 *   4. 候補が1つも無い場合(登校日でもなく、予定も無い)はnullを返す。
 * @param {Date} targetDate 対象日
 * @param {string} calendarId 家族共有カレンダーのID
 * @param {string} namePrefix '【ゆうき】' または '【みつき】'
 * @param {string} defaultTimeStr 通常下校時刻(例: '16:00')
 * @return {{time: Date, source: 'calendar'|'default', label: string}|null}
 */
function getHomewardDepartureTime_(targetDate, calendarId, namePrefix, defaultTimeStr) {
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  let latestEventEnd = null;
  let latestEventLabel = null;
  try {
    const calendar = CalendarApp.getCalendarById(calendarId);
    const events = calendar.getEvents(dayStart, dayEnd);
    events.forEach(function (ev) {
      if (ev.getTitle().indexOf(namePrefix) !== 0 || ev.isAllDayEvent()) return;
      const end = ev.getEndTime();
      if (!latestEventEnd || end > latestEventEnd) {
        latestEventEnd = end;
        latestEventLabel = ev.getTitle().replace(namePrefix, '');
      }
    });
  } catch (e) {
    Logger.log('下校時刻算出中のカレンダー確認でエラー: ' + e.message);
  }

  const isSchool = isSchoolDay_(targetDate, calendarId, namePrefix);
  const defaultTime = isSchool ? new Date(dateStr + 'T' + defaultTimeStr + ':00') : null;

  if (latestEventEnd && defaultTime) {
    return latestEventEnd.getTime() >= defaultTime.getTime()
      ? { time: latestEventEnd, source: 'calendar', label: latestEventLabel }
      : { time: defaultTime, source: 'default', label: '通常下校' };
  }
  if (latestEventEnd) {
    return { time: latestEventEnd, source: 'calendar', label: latestEventLabel };
  }
  if (defaultTime) {
    return { time: defaultTime, source: 'default', label: '通常下校' };
  }
  return null; // 登校日でもなく、時刻付きの予定も無い日
}
