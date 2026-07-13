export type LocalDomain =
  | 'chat'
  | 'weather'
  | 'activity'
  | 'mail'
  | 'files'
  | 'web'
  | 'reminders'
  | 'memory';

export interface LocalRouteDecision {
  provider: 'ollama' | 'claude';
  domain: LocalDomain | null;
  toolNames: string[];
  reason: string;
}

export const LOCAL_TOOL_GROUPS: Readonly<Record<Exclude<LocalDomain, 'chat'>, readonly string[]>> = {
  weather: ['weather'],
  activity: ['activity'],
  mail: ['emails_status', 'emails_list', 'emails_get'],
  files: ['file_list', 'file_read'],
  web: ['web_search', 'web_fetch'],
  reminders: ['reminder_list'],
  memory: ['memory_search'],
};

const TOOL_DOMAIN = new Map<string, Exclude<LocalDomain, 'chat'>>(
  Object.entries(LOCAL_TOOL_GROUPS).flatMap(([domain, names]) =>
    names.map((name) => [name, domain as Exclude<LocalDomain, 'chat'>]),
  ),
);

const DOMAIN_PATTERNS: ReadonlyArray<[Exclude<LocalDomain, 'chat'>, RegExp]> = [
  ['weather', /(погод|прогноз погоди|weather|температур)/i],
  ['activity', /(активност|активніст|экранн|екранн|за компьютер|за комп'ютер|чим я займ|что я делал|що я робив|digital observer)/i],
  ['mail', /(почт|пошт|письм|листи|листів|листа|email|inbox)/i],
  ['files', /(файл|папк|директор|каталог)/i],
  ['reminders', /(напоминан|нагадуван|reminder)/i],
  ['memory', /(памят|пам'ят|помни|что ты знаешь обо мне|що ти знаєш про мене|кто я|хто я)/i],
  ['web', /(интернет|інтернет|в сети|у мережі|новост|новин|курс валют|котиров|ц[еі]н[аыи]|сайт|страниц|сторінк|\burl\b|\bweb\b)/i],
];

const ACTION_PATTERN = /(?:\b(?:create|write|delete|remove|move|rename|send|deploy|dismiss|remember|forget|update|schedule|cancel)\b|созда(?:й|ть)|створ(?:и|ити)|добавь|додай|поставь|запиши|записать|сохрани|збереж|удали|удалить|видали|перемести|переміст|переимен|переймен|отправ|відправ|надіш|запомни|запам'ятай|забудь|обнови|онови|измени|зміни|напомни|нагадай|пометь|познач|разобрал|розібрав|закрой|закрий|ответь на (?:письмо|лист)|відповідай на (?:письмо|лист)|прибери (?:лист|письмо)|скасуй нагад|отмени напомин)/i;
const CODE_PATTERN = /(?:\b(?:typescript|javascript|python|golang|rust|java|sql|api|debug|docker|kubernetes|git|regex)\b|код|программ|програмув|функци|класс|репозитор|баг|помилк.*код)/i;
const MATH_PATTERN = /(?:\d\s*(?:\+|-|\*|\/|=|\^)\s*\d|сколько будет|скільки буде|реши (?:задач|уравнен)|розв'яжи|calculate|equation|процент.*(?:от|від))/i;
const STRICT_OUTPUT_PATTERN = /(?:\b(?:json|yaml|csv|xml|schema|structured output|extract|sort)\b|строго.*формат|точно.*формат|лишь json|только json|тільки json|без пояснен|только ответ|тільки відповідь|сортир|відсорту|упорядоч|извлеки|витягни)/i;
const COMPLEX_REASONING_PATTERN = /(?:сравни|порівняй|\bcompare\b|исследуй|досліди|\bresearch\b)/i;
const UNTRUSTED_PATTERN = /(?:ignore (?:all |the )?previous|игнорируй (?:все |всі )?(?:предыдущ|попередн)|system prompt|developer message|<script\b|begin (?:system|instructions)|\btool_calls?\b)/i;
const MULTI_STEP_PATTERN = /(?:сначала[\s\S]{0,500}(?:потом|затем)|спочатку[\s\S]{0,500}(?:потім|далі)|\bfirst[\s\S]{0,500}\bthen\b)/i;

function claude(reason: string, domain: LocalDomain | null = null): LocalRouteDecision {
  return { provider: 'claude', domain, toolNames: [], reason };
}

function detectDomains(text: string): Array<Exclude<LocalDomain, 'chat'>> {
  const domains = DOMAIN_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([domain]) => domain);
  if (domains.length === 0 && /(?:найди|знайди|поищи|пошукай|\bsearch\b|look up)/i.test(text)) {
    domains.push('web');
  }
  return [...new Set(domains)];
}

export function isLocalReadTool(name: string): boolean {
  return TOOL_DOMAIN.has(name);
}

export function getLocalToolDomain(name: string): Exclude<LocalDomain, 'chat'> | null {
  return TOOL_DOMAIN.get(name) ?? null;
}

export function decideLocalRoute(params: {
  text: string;
  requestedToolName?: string;
  maxChars?: number;
}): LocalRouteDecision {
  const text = params.text.trim();

  if (params.requestedToolName) {
    const domain = getLocalToolDomain(params.requestedToolName);
    if (!domain) return claude('slash_tool_requires_claude');
    return {
      provider: 'ollama',
      domain,
      toolNames: [params.requestedToolName],
      reason: 'local_read_slash_command',
    };
  }

  const maxCharsRaw = params.maxChars ?? Number(process.env.OLLAMA_ROUTE_MAX_CHARS);
  const maxChars = Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? maxCharsRaw : 4000;
  if (text.length > maxChars) return claude('request_too_long');
  if (UNTRUSTED_PATTERN.test(text)) return claude('untrusted_instruction_content');
  if (ACTION_PATTERN.test(text)) return claude('state_changing_intent');
  if (CODE_PATTERN.test(text)) return claude('code_or_technical_task');
  if (MATH_PATTERN.test(text)) return claude('math_or_calculation');
  if (STRICT_OUTPUT_PATTERN.test(text)) return claude('strict_output_contract');
  if (COMPLEX_REASONING_PATTERN.test(text)) return claude('complex_reasoning');
  if (MULTI_STEP_PATTERN.test(text)) return claude('multi_step_request');

  const domains = detectDomains(text);
  if (domains.length > 1) return claude('multiple_tool_domains');
  if (domains.length === 1) {
    const domain = domains[0];
    return {
      provider: 'ollama',
      domain,
      toolNames: [...LOCAL_TOOL_GROUPS[domain]],
      reason: 'single_read_domain',
    };
  }

  return { provider: 'ollama', domain: 'chat', toolNames: [], reason: 'simple_chat' };
}
