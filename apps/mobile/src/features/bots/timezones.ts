/**
 * bot 的**时区**（bot 记录上的 `timezone` 字段）。
 *
 * ## 这个字段是什么、谁在读它
 *
 * `timezone` 是服务端的**执行时区**：`internal/schedule/service.go` 的
 * `resolveBotLocation` 按它解释 cron 表达式（`docs/schedule.md` 第 3 条）。也就是说，
 * 用户在定时任务里写的 `0 9 * * *` 指的是**这个时区的 09:00**。这正是为什么这一行必须
 * 让用户看得见、也改得动——否则用户设的时间和他以为的时区永远对不上。
 *
 * ## 空值的语义（实测，不是猜的）
 *
 * 2026-09-16 在部署实例（`memohai/server` 8/30 镜像）上实测：
 *
 * - `PUT /bots/{id} {"timezone": ""}` → 200，随后 `GET /bots/{id}` 里 **`timezone` 这个
 *   key 直接消失**（Go 侧 `Timezone string json:"timezone,omitempty"`），`GET …/settings`
 *   也回空串。服务端这时按**部署默认**算（本部署是 UTC，见 `describe.ts`）。
 *   所以"清掉"是这条路的合法动作，不是发了个坏值。→ `INHERIT_TIMEZONE`。
 * - `POST /bots/{id}/settings {"timezone": ""}` → 200 但**什么都不会变**
 *   （SQL 是 `timezone = COALESCE(narg(timezone), bots.timezone)`，空串与"没带这个字段"
 *   不可区分）。桌面端也把它当"不是 settings 端点的字段"，单独走 `PUT /bots/{id}`
 *   （`bot-settings.vue` 的 `buildJobs`）。所以**这里也走 bot 那条路**，走 settings
 *   只会让"清空"这个动作静默失效。
 * - 写进去的值服务端会用 `time.LoadLocation` 校验并归一化（非法值整条 400）。
 *
 * ## 选项清单
 *
 * `TIMEZONES` 是打包进来的一份（见那个常量的注释）。不认识的原始值**原样保留**
 * ——与 `languages.ts` 同一条规矩：服务端存了什么就显示什么，静默改写成"继承"
 * 才是真丢用户设置。
 */
import { DEPLOYMENT_DEFAULT_TIMEZONE } from '../schedule/describe.ts';

export { DEPLOYMENT_DEFAULT_TIMEZONE };

/**
 * "继承部署默认"。
 *
 * 值是空串：`PUT /bots/{id}` 收到空串就把列写成 NULL（实测见文件头）。
 * 用空串而不是一个哨兵字符串，是为了让 `patchFrom` 的差分判断直接可用
 * （服务端读回来也是空/缺失，两边一比就知道用户改没改）。
 */
export const INHERIT_TIMEZONE = '';

/**
 * 全部可选的 IANA 名字：`UTC` 打头，其余按 ICU 给的字母序（共 419 项）。
 *
 * `UTC` 破例排在最前面：它是"显式写死一个时区"里最常用的那一个，也是本部署的默认值，
 * 用户从"继承"切成"写死"时第一个想找的就是它——而按字母序它落在最后一行。
 */
export const TIMEZONES: readonly string[] = [
  'UTC',
  'Africa/Abidjan',
  'Africa/Accra',
  'Africa/Addis_Ababa',
  'Africa/Algiers',
  'Africa/Asmera',
  'Africa/Bamako',
  'Africa/Bangui',
  'Africa/Banjul',
  'Africa/Bissau',
  'Africa/Blantyre',
  'Africa/Brazzaville',
  'Africa/Bujumbura',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Ceuta',
  'Africa/Conakry',
  'Africa/Dakar',
  'Africa/Dar_es_Salaam',
  'Africa/Djibouti',
  'Africa/Douala',
  'Africa/El_Aaiun',
  'Africa/Freetown',
  'Africa/Gaborone',
  'Africa/Harare',
  'Africa/Johannesburg',
  'Africa/Juba',
  'Africa/Kampala',
  'Africa/Khartoum',
  'Africa/Kigali',
  'Africa/Kinshasa',
  'Africa/Lagos',
  'Africa/Libreville',
  'Africa/Lome',
  'Africa/Luanda',
  'Africa/Lubumbashi',
  'Africa/Lusaka',
  'Africa/Malabo',
  'Africa/Maputo',
  'Africa/Maseru',
  'Africa/Mbabane',
  'Africa/Mogadishu',
  'Africa/Monrovia',
  'Africa/Nairobi',
  'Africa/Ndjamena',
  'Africa/Niamey',
  'Africa/Nouakchott',
  'Africa/Ouagadougou',
  'Africa/Porto-Novo',
  'Africa/Sao_Tome',
  'Africa/Tripoli',
  'Africa/Tunis',
  'Africa/Windhoek',
  'America/Adak',
  'America/Anchorage',
  'America/Anguilla',
  'America/Antigua',
  'America/Araguaina',
  'America/Argentina/La_Rioja',
  'America/Argentina/Rio_Gallegos',
  'America/Argentina/Salta',
  'America/Argentina/San_Juan',
  'America/Argentina/San_Luis',
  'America/Argentina/Tucuman',
  'America/Argentina/Ushuaia',
  'America/Aruba',
  'America/Asuncion',
  'America/Bahia',
  'America/Bahia_Banderas',
  'America/Barbados',
  'America/Belem',
  'America/Belize',
  'America/Blanc-Sablon',
  'America/Boa_Vista',
  'America/Bogota',
  'America/Boise',
  'America/Buenos_Aires',
  'America/Cambridge_Bay',
  'America/Campo_Grande',
  'America/Cancun',
  'America/Caracas',
  'America/Catamarca',
  'America/Cayenne',
  'America/Cayman',
  'America/Chicago',
  'America/Chihuahua',
  'America/Ciudad_Juarez',
  'America/Coral_Harbour',
  'America/Cordoba',
  'America/Costa_Rica',
  'America/Coyhaique',
  'America/Creston',
  'America/Cuiaba',
  'America/Curacao',
  'America/Danmarkshavn',
  'America/Dawson',
  'America/Dawson_Creek',
  'America/Denver',
  'America/Detroit',
  'America/Dominica',
  'America/Edmonton',
  'America/Eirunepe',
  'America/El_Salvador',
  'America/Fort_Nelson',
  'America/Fortaleza',
  'America/Glace_Bay',
  'America/Godthab',
  'America/Goose_Bay',
  'America/Grand_Turk',
  'America/Grenada',
  'America/Guadeloupe',
  'America/Guatemala',
  'America/Guayaquil',
  'America/Guyana',
  'America/Halifax',
  'America/Havana',
  'America/Hermosillo',
  'America/Indiana/Knox',
  'America/Indiana/Marengo',
  'America/Indiana/Petersburg',
  'America/Indiana/Tell_City',
  'America/Indiana/Vevay',
  'America/Indiana/Vincennes',
  'America/Indiana/Winamac',
  'America/Indianapolis',
  'America/Inuvik',
  'America/Iqaluit',
  'America/Jamaica',
  'America/Jujuy',
  'America/Juneau',
  'America/Kentucky/Monticello',
  'America/Kralendijk',
  'America/La_Paz',
  'America/Lima',
  'America/Los_Angeles',
  'America/Louisville',
  'America/Lower_Princes',
  'America/Maceio',
  'America/Managua',
  'America/Manaus',
  'America/Marigot',
  'America/Martinique',
  'America/Matamoros',
  'America/Mazatlan',
  'America/Mendoza',
  'America/Menominee',
  'America/Merida',
  'America/Metlakatla',
  'America/Mexico_City',
  'America/Miquelon',
  'America/Moncton',
  'America/Monterrey',
  'America/Montevideo',
  'America/Montserrat',
  'America/Nassau',
  'America/New_York',
  'America/Nome',
  'America/Noronha',
  'America/North_Dakota/Beulah',
  'America/North_Dakota/Center',
  'America/North_Dakota/New_Salem',
  'America/Ojinaga',
  'America/Panama',
  'America/Paramaribo',
  'America/Phoenix',
  'America/Port-au-Prince',
  'America/Port_of_Spain',
  'America/Porto_Velho',
  'America/Puerto_Rico',
  'America/Punta_Arenas',
  'America/Rankin_Inlet',
  'America/Recife',
  'America/Regina',
  'America/Resolute',
  'America/Rio_Branco',
  'America/Santarem',
  'America/Santiago',
  'America/Santo_Domingo',
  'America/Sao_Paulo',
  'America/Scoresbysund',
  'America/Sitka',
  'America/St_Barthelemy',
  'America/St_Johns',
  'America/St_Kitts',
  'America/St_Lucia',
  'America/St_Thomas',
  'America/St_Vincent',
  'America/Swift_Current',
  'America/Tegucigalpa',
  'America/Thule',
  'America/Tijuana',
  'America/Toronto',
  'America/Tortola',
  'America/Vancouver',
  'America/Whitehorse',
  'America/Winnipeg',
  'America/Yakutat',
  'Antarctica/Casey',
  'Antarctica/Davis',
  'Antarctica/DumontDUrville',
  'Antarctica/Macquarie',
  'Antarctica/Mawson',
  'Antarctica/McMurdo',
  'Antarctica/Palmer',
  'Antarctica/Rothera',
  'Antarctica/Syowa',
  'Antarctica/Troll',
  'Antarctica/Vostok',
  'Arctic/Longyearbyen',
  'Asia/Aden',
  'Asia/Almaty',
  'Asia/Amman',
  'Asia/Anadyr',
  'Asia/Aqtau',
  'Asia/Aqtobe',
  'Asia/Ashgabat',
  'Asia/Atyrau',
  'Asia/Baghdad',
  'Asia/Bahrain',
  'Asia/Baku',
  'Asia/Bangkok',
  'Asia/Barnaul',
  'Asia/Beirut',
  'Asia/Bishkek',
  'Asia/Brunei',
  'Asia/Calcutta',
  'Asia/Chita',
  'Asia/Colombo',
  'Asia/Damascus',
  'Asia/Dhaka',
  'Asia/Dili',
  'Asia/Dubai',
  'Asia/Dushanbe',
  'Asia/Famagusta',
  'Asia/Gaza',
  'Asia/Hebron',
  'Asia/Hong_Kong',
  'Asia/Hovd',
  'Asia/Irkutsk',
  'Asia/Jakarta',
  'Asia/Jayapura',
  'Asia/Jerusalem',
  'Asia/Kabul',
  'Asia/Kamchatka',
  'Asia/Karachi',
  'Asia/Katmandu',
  'Asia/Khandyga',
  'Asia/Krasnoyarsk',
  'Asia/Kuala_Lumpur',
  'Asia/Kuching',
  'Asia/Kuwait',
  'Asia/Macau',
  'Asia/Magadan',
  'Asia/Makassar',
  'Asia/Manila',
  'Asia/Muscat',
  'Asia/Nicosia',
  'Asia/Novokuznetsk',
  'Asia/Novosibirsk',
  'Asia/Omsk',
  'Asia/Oral',
  'Asia/Phnom_Penh',
  'Asia/Pontianak',
  'Asia/Pyongyang',
  'Asia/Qatar',
  'Asia/Qostanay',
  'Asia/Qyzylorda',
  'Asia/Rangoon',
  'Asia/Riyadh',
  'Asia/Saigon',
  'Asia/Sakhalin',
  'Asia/Samarkand',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Srednekolymsk',
  'Asia/Taipei',
  'Asia/Tashkent',
  'Asia/Tbilisi',
  'Asia/Tehran',
  'Asia/Thimphu',
  'Asia/Tokyo',
  'Asia/Tomsk',
  'Asia/Ulaanbaatar',
  'Asia/Urumqi',
  'Asia/Ust-Nera',
  'Asia/Vientiane',
  'Asia/Vladivostok',
  'Asia/Yakutsk',
  'Asia/Yekaterinburg',
  'Asia/Yerevan',
  'Atlantic/Azores',
  'Atlantic/Bermuda',
  'Atlantic/Canary',
  'Atlantic/Cape_Verde',
  'Atlantic/Faeroe',
  'Atlantic/Madeira',
  'Atlantic/Reykjavik',
  'Atlantic/South_Georgia',
  'Atlantic/St_Helena',
  'Atlantic/Stanley',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Broken_Hill',
  'Australia/Darwin',
  'Australia/Eucla',
  'Australia/Hobart',
  'Australia/Lindeman',
  'Australia/Lord_Howe',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Andorra',
  'Europe/Astrakhan',
  'Europe/Athens',
  'Europe/Belgrade',
  'Europe/Berlin',
  'Europe/Bratislava',
  'Europe/Brussels',
  'Europe/Bucharest',
  'Europe/Budapest',
  'Europe/Busingen',
  'Europe/Chisinau',
  'Europe/Copenhagen',
  'Europe/Dublin',
  'Europe/Gibraltar',
  'Europe/Guernsey',
  'Europe/Helsinki',
  'Europe/Isle_of_Man',
  'Europe/Istanbul',
  'Europe/Jersey',
  'Europe/Kaliningrad',
  'Europe/Kiev',
  'Europe/Kirov',
  'Europe/Lisbon',
  'Europe/Ljubljana',
  'Europe/London',
  'Europe/Luxembourg',
  'Europe/Madrid',
  'Europe/Malta',
  'Europe/Mariehamn',
  'Europe/Minsk',
  'Europe/Monaco',
  'Europe/Moscow',
  'Europe/Oslo',
  'Europe/Paris',
  'Europe/Podgorica',
  'Europe/Prague',
  'Europe/Riga',
  'Europe/Rome',
  'Europe/Samara',
  'Europe/San_Marino',
  'Europe/Sarajevo',
  'Europe/Saratov',
  'Europe/Simferopol',
  'Europe/Skopje',
  'Europe/Sofia',
  'Europe/Stockholm',
  'Europe/Tallinn',
  'Europe/Tirane',
  'Europe/Ulyanovsk',
  'Europe/Vaduz',
  'Europe/Vatican',
  'Europe/Vienna',
  'Europe/Vilnius',
  'Europe/Volgograd',
  'Europe/Warsaw',
  'Europe/Zagreb',
  'Europe/Zurich',
  'Indian/Antananarivo',
  'Indian/Chagos',
  'Indian/Christmas',
  'Indian/Cocos',
  'Indian/Comoro',
  'Indian/Kerguelen',
  'Indian/Mahe',
  'Indian/Maldives',
  'Indian/Mauritius',
  'Indian/Mayotte',
  'Indian/Reunion',
  'Pacific/Apia',
  'Pacific/Auckland',
  'Pacific/Bougainville',
  'Pacific/Chatham',
  'Pacific/Easter',
  'Pacific/Efate',
  'Pacific/Enderbury',
  'Pacific/Fakaofo',
  'Pacific/Fiji',
  'Pacific/Funafuti',
  'Pacific/Galapagos',
  'Pacific/Gambier',
  'Pacific/Guadalcanal',
  'Pacific/Guam',
  'Pacific/Honolulu',
  'Pacific/Kiritimati',
  'Pacific/Kosrae',
  'Pacific/Kwajalein',
  'Pacific/Majuro',
  'Pacific/Marquesas',
  'Pacific/Midway',
  'Pacific/Nauru',
  'Pacific/Niue',
  'Pacific/Norfolk',
  'Pacific/Noumea',
  'Pacific/Pago_Pago',
  'Pacific/Palau',
  'Pacific/Pitcairn',
  'Pacific/Ponape',
  'Pacific/Port_Moresby',
  'Pacific/Rarotonga',
  'Pacific/Saipan',
  'Pacific/Tahiti',
  'Pacific/Tarawa',
  'Pacific/Tongatapu',
  'Pacific/Truk',
  'Pacific/Wake',
  'Pacific/Wallis',
];

/**
 * 服务端读回来的值 → 草稿值。
 *
 * 三种情形都是"继承"：key 缺失（服务端没设过，实测就是这样）、空串、`null`。
 * 别的值**原样保留**——包括我们不认识的（比如服务端存了个别名）：静默改写成
 * "继承"等于替用户把设置丢了，而这条路的代价是他下次保存时被覆盖。
 */
export function normalizeTimezone(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** 一个名字在运行时的 Intl 里认不认。认不出来（或为空）就不能拿来算时间。 */
export function isUsableTimezone(timezone: string): boolean {
  if (timezone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export interface EffectiveTimezone {
  /** 真正用来算时间的那个名字（继承时是部署默认）。 */
  zone: string;
  /** true = bot 上没设（或写了个非法值），服务端回落部署默认。 */
  inherited: boolean;
}

/**
 * 当前**生效**的时区。
 *
 * 与 `features/schedule/describe.ts` 的 `safeTimezone` 同一套判断（服务端在缺失或非法时
 * 回落部署默认），区别是这里额外把"是不是继承来的"说出来——界面上要能区分
 * "我设了 UTC"和"我没设、服务端按 UTC 算"。
 */
export function effectiveTimezone(raw: string | null | undefined): EffectiveTimezone {
  const value = normalizeTimezone(raw);
  if (value === '' || !isUsableTimezone(value)) {
    return { zone: DEPLOYMENT_DEFAULT_TIMEZONE, inherited: true };
  }
  return { zone: value, inherited: false };
}

/**
 * 时区那一行的文案 key 与插值。
 *
 * 纯函数（不碰 i18n、不碰 React），因为"这句话到底对不对"是能测的：
 * 继承时说的是部署默认，设过时说的是用户设的那个名字，两种不能混。
 */
export function timezoneLine(raw: string | null | undefined): {
  key: string;
  values: { timezone: string };
} {
  const { zone, inherited } = effectiveTimezone(raw);
  return {
    key: inherited ? 'timezone.line.inherited' : 'timezone.line.set',
    values: { timezone: zone },
  };
}

/**
 * bot 设置那一行右侧的**值**。
 *
 * 与 `timezoneLine` 分开：设置行被列宽挤着，要短（"继承（UTC）"而不是一整句），
 * 而定时界面那一行是脚注，可以说全。两个都用同一套 `effectiveTimezone`，
 * 所以"现在到底按哪个时区算"在三个地方只有一个答案。
 */
export function timezoneValue(raw: string | null | undefined): {
  key: string;
  values: { timezone: string };
} {
  const { zone, inherited } = effectiveTimezone(raw);
  return {
    key: inherited ? 'timezone.value.inherited' : 'timezone.value.set',
    values: { timezone: zone },
  };
}

/** 列表里的副标题：`UTC+08:00`（拿不到偏移就返回空串，宁可不显示也不编）。 */
export function timezoneSubtitle(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * 搜索：把 `_` / `/` / `-` / 空格都抹掉再比。
 *
 * 用户想找"纽约"，会打 `new york`（打不出 `America/New_York` 里的下划线）；想找
 * 上海会打 `shanghai` 或 `asia/shanghai`。两种都得命中，所以比较前先把分隔符统一去掉，
 * 同时保留原串的大小写不敏感匹配（`asia/` 这种带区域前缀的输入）。
 *
 * 不做的事：不拿偏移量参与搜索。那要为 419 个名字各构造一次 `Intl.DateTimeFormat`，
 * 每敲一个字就是 419 次（桌面端为此专门做了 memo 与后台预热）——手机上这个代价换不来
 * 多少命中率，用户打的是地名。
 */
export function filterTimezones(query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...TIMEZONES];
  const squeezed = needle.replace(/[\s/_-]/g, '');
  return TIMEZONES.filter((zone) => {
    const lower = zone.toLowerCase();
    if (lower.includes(needle)) return true;
    return squeezed !== '' && lower.replace(/[\s/_-]/g, '').includes(squeezed);
  });
}

/** 时区的最后一段（`America/New_York` → `New York`）：手机上列表窄，先看城市。 */
export function timezoneCity(timezone: string): string {
  const tail = timezone.split('/').pop() ?? timezone;
  return tail.replace(/_/g, ' ');
}
