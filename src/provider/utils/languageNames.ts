/**
 * Map ISO 639-1/639-2 language codes to native language names
 * Returns language names in their native scripts
 */
export function getNativeLanguageName(code: string): string {
  const normalized = code.toLowerCase().trim();

  const nativeNames: Record<string, string> = {
    // 🌍 Global
    en: 'English',
    es: 'Español',
    'es-419': 'Español (Latinoamérica)',
    'es-ES': 'Español (España)',
    'es-MX': 'Español (México)',
    fr: 'Français',
    'fr-CA': 'Français (Canada)',
    de: 'Deutsch',
    it: 'Italiano',
    pt: 'Português',
    'pt-BR': 'Português (Brasil)',
    'pt-PT': 'Português (Portugal)',
    ru: 'Русский',

    // 🌏 East Asia
    ja: '日本語',
    ko: '한국어',
    zh: '中文',
    'zh-Hans': '简体中文',
    'zh-Hant': '繁體中文',
    'zh-CN': '中文 (简体)',
    'zh-TW': '中文 (繁體)',
    'zh-HK': '中文 (香港)',

    // 🌍 Middle East
    ar: 'العربية',
    he: 'עברית',
    fa: 'فارسی',
    ur: 'اردو',

    // 🇮🇳 Indian languages
    hi: 'हिन्दी',
    bn: 'বাংলা',
    pa: 'ਪੰਜਾਬੀ',
    gu: 'ગુજરાતી',
    te: 'తెలుగు',
    mr: 'मराठी',
    ta: 'தமிழ்',
    kn: 'ಕನ್ನಡ',
    ml: 'മലയാളം',
    or: 'ଓଡ଼ିଆ',
    as: 'অসমীয়া',
    ne: 'नेपाली',
    si: 'සිංහල',

    // 🌏 Southeast Asia
    id: 'Bahasa Indonesia',
    ms: 'Bahasa Melayu',
    vi: 'Tiếng Việt',
    th: 'ไทย',
    tl: 'Filipino',
    km: 'ខ្មែរ',
    lo: 'ລາວ',
    my: 'မြန်မာ',

    // 🌍 Europe
    nl: 'Nederlands',
    pl: 'Polski',
    sv: 'Svenska',
    no: 'Norsk',
    da: 'Dansk',
    fi: 'Suomi',
    cs: 'Čeština',
    hu: 'Magyar',
    ro: 'Română',
    el: 'Ελληνικά',
    uk: 'Українська',
    bg: 'Български',
    hr: 'Hrvatski',
    sk: 'Slovenčina',
    sl: 'Slovenščina',
    sr: 'Српски',
    ca: 'Català',
    eu: 'Euskara',
    lt: 'Lietuvių',
    lv: 'Latviešu',
    et: 'Eesti',
    is: 'Íslenska',
    mt: 'Malti',
    sq: 'Shqip',
    mk: 'Македонски',
    bs: 'Bosanski',
    ga: 'Gaeilge',
    cy: 'Cymraeg',
    gl: 'Galego',

    // 🌍 Africa
    sw: 'Kiswahili',
    af: 'Afrikaans',
    zu: 'isiZulu',
    xh: 'isiXhosa',
    am: 'አማርኛ',

    // 🌏 Others
    tr: 'Türkçe',
  };

  return nativeNames[normalized] || code.toUpperCase();
}
