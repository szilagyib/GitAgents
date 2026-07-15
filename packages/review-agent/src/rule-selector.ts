import type { RuleApplicability, RuleMap } from "@gitagents/core";
import type { ProjectProfileDetection } from "./project-profile.js";

export interface RuleSelectionInput {
  filePath: string;
  fileContent: string;
  hybridContext: string;
  projectText?: string;
  projectProfile?: ProjectProfileDetection;
}

type RulePredicate = (signals: RuleSignals) => boolean;

interface RuleSignals {
  filePath: string;
  text: string;
  projectText: string;
  profileNames: Set<string>;
  signalNames: Set<string>;
}

const JAVA_RULE_PREDICATES: Record<string, RulePredicate> = {
  "spring-security": (signals) => hasSpringSignals(signals),
  "jpa-lazy-loading": (signals) => hasJpaSignals(signals),
  "transaction-boundaries": (signals) =>
    hasSpringSignals(signals) || hasJpaSignals(signals) || hasDatabaseWriteSignals(signals),
  "java-time": (signals) =>
    /\b(date|calendar|instant|localdate|localdatetime|zoneddatetime|zoneid|timezone|timestamp)\b/.test(
      signals.text,
    ),
  "numeric-precision": (signals) =>
    /\b(money|amount|price|total|subtotal|currency|rate|tax|discount|bigdecimal|double|float)\b/.test(
      signals.text,
    ),
  "concurrency-primitives": (signals) =>
    /\b(synchronized|volatile|thread|runnable|completablefuture|executor|atomic\w+|concurrenthashmap|lock)\b/.test(
      signals.text,
    ),
  "collection-api-misuse": (signals) =>
    /\b(map|set|list|collection|hashmap|hashset|arraylist|keyset|entryset|contains|add)\b/.test(
      signals.text,
    ),
  "stream-api-misuse": (signals) => /\bstream\s*\(|\bstream<|\bcollectors\b/.test(signals.text),
  "serialization-safety": (signals) =>
    /\bserializable\b|\bserialversionuid\b|\btransient\b/.test(signals.text),
};

const TYPESCRIPT_RULE_PREDICATES: Record<string, RulePredicate> = {
  "async-errors": (signals) =>
    /\b(async|await|promise|then\s*\(|catch\s*\(|settimeout|setinterval)\b/.test(signals.text),
  "request-validation": (signals) => hasRequestInputSignals(signals),
  "callback-promise-mismatch": (signals) =>
    /\basync\b/.test(signals.text) &&
    /\b(foreach|map|filter|reduce|on|addeventlistener|useeffect|middleware)\s*\(/.test(signals.text),
  "exhaustive-switch": (signals) => /\bswitch\s*\(|\benum\b|\btype\b.*\|/.test(signals.text),
  "react-hooks": (signals) => hasReactSignals(signals),
  "server-side-security": (signals) => hasServerSignals(signals),
  "closure-pitfalls": (signals) =>
    hasReactSignals(signals) ||
    /\b(settimeout|setinterval|addeventlistener|removeeventlistener|on\s*\(|subscribe\s*\()\b/.test(
      signals.text,
    ),
  "prototype-pollution": (signals) =>
    hasRequestInputSignals(signals) &&
    /(?:\bobject\.assign|\bmerge\s*\(|\bset\s*\(|\[\s*[\w.]+\s*\])/.test(signals.text),
};

export function selectRelevantRules(rules: RuleMap, input: RuleSelectionInput): RuleMap {
  const signals = buildSignals(input);
  const selected: RuleMap = new Map();

  for (const [ruleId, rule] of rules) {
    if (rule.applicability) {
      if (matchesStructuredApplicability(rule.applicability, signals)) {
        selected.set(ruleId, rule);
      }
      continue;
    }

    const predicate = JAVA_RULE_PREDICATES[ruleId] ?? TYPESCRIPT_RULE_PREDICATES[ruleId];
    if (predicate && !predicate(signals)) continue;
    selected.set(ruleId, rule);
  }

  return selected;
}

function buildSignals(input: RuleSelectionInput): RuleSignals {
  const projectText = normalize(`${input.projectText ?? ""}`);
  return {
    filePath: input.filePath.toLowerCase(),
    text: normalize([input.filePath, input.fileContent, input.hybridContext, input.projectText ?? ""].join("\n")),
    projectText,
    profileNames: input.projectProfile?.profiles ?? new Set(),
    signalNames: new Set([
      ...(input.projectProfile?.signals ?? []),
      ...detectLocalSignals(input.filePath, input.fileContent, input.hybridContext, input.projectText ?? ""),
    ]),
  };
}

function matchesStructuredApplicability(
  applicability: RuleApplicability,
  signals: RuleSignals,
): boolean {
  const profiles = applicability.profiles ?? [];
  const optionalSignals = applicability.signals ?? [];
  const requiredSignals = applicability.requiredSignals ?? [];
  const requiredSignalsMatch =
    requiredSignals.length === 0 ||
    requiredSignals.every((signal) => signals.signalNames.has(signal));

  if (!requiredSignalsMatch) return false;
  if (profiles.length === 0 && optionalSignals.length === 0) return true;
  if (profiles.some((profile) => signals.profileNames.has(profile))) return true;
  return optionalSignals.some((signal) => signals.signalNames.has(signal));
}

function detectLocalSignals(
  filePath: string,
  fileContent: string,
  hybridContext: string,
  projectText: string,
): string[] {
  const text = normalize([filePath, fileContent, hybridContext, projectText].join("\n"));
  const localSignals = new Set<string>();

  if (hasSpringSignalsFromText(text)) localSignals.add("spring");
  if (hasJpaSignalsFromText(text)) localSignals.add("jpa");
  if (hasReactSignalsFromText(filePath.toLowerCase(), text)) localSignals.add("react");
  if (hasServerSignalsFromText(filePath.toLowerCase(), text)) localSignals.add("server");
  if (isCppPath(filePath) || /#include\s*[<"][^>"]+[>"]/.test(text)) {
    localSignals.add("cpp");
    localSignals.add("c-cpp");
  }
  if (/\basync\b|\bawait\b|\bpromise\b|then\s*\(/.test(text)) localSignals.add("async");
  if (/\b(body|query|params|headers|cookies|json\.parse|urlsearchparams|formdata|process\.env)\b/.test(text)) {
    localSignals.add("external-input");
  }
  if (/\bobject\.assign|\bmerge\s*\(|\[\s*[\w.]+\s*\]/.test(text)) localSignals.add("dynamic-key");
  if (/\b(foreach|map|filter|reduce|settimeout|setinterval|addeventlistener|removeeventlistener|on|subscribe|middleware)\s*\(/.test(text)) {
    localSignals.add("callback");
  }
  if (/\bswitch\s*\(|\benum\b|\btype\b.*\|/.test(text)) localSignals.add("branching");
  if (/\b(date|calendar|instant|localdate|localdatetime|zoneddatetime|zoneid|timezone|timestamp)\b/.test(text)) {
    localSignals.add("date-time");
  }
  if (/\b(money|amount|price|total|subtotal|currency|rate|tax|discount|bigdecimal|double|float)\b/.test(text)) {
    localSignals.add("numeric");
  }
  if (/\b(size_t|int32_t|uint32_t|int64_t|uint64_t|sizeof|strlen|capacity|length|count|bytes|offset)\b/.test(text)) {
    localSignals.add("numeric");
  }
  if (/(?:\w+\s*->|\*\s*\w+|\bnullptr\b|\bnull\b)/.test(text)) localSignals.add("pointer");
  if (/\b(malloc|calloc|realloc|free|new|delete|std::unique_ptr|std::shared_ptr|std::move)\b/.test(text)) {
    localSignals.add("ownership");
    localSignals.add("raw-memory");
  }
  if (/\b(char\s+\w+\s*\[|strcpy|strncpy|strcat|strncat|sprintf|snprintf|memcpy|memmove|memset|gets)\b/.test(text)) {
    localSignals.add("buffer");
    localSignals.add("c-string");
  }
  if (/\b(printf|fprintf|sprintf|snprintf|scanf|sscanf|syslog)\s*\(/.test(text)) {
    localSignals.add("format-string");
  }
  if (/\b(fopen|open|close|socket|mutex|lock_guard|unique_lock|pthread_mutex|file|handle)\b/.test(text)) {
    localSignals.add("resource");
  }
  if (/\b(synchronized|volatile|thread|runnable|completablefuture|executor|atomic\w+|concurrenthashmap|lock)\b/.test(text)) {
    localSignals.add("concurrency");
  }
  if (/\b(std::thread|pthread_|std::mutex|std::atomic|condition_variable|lock_guard|unique_lock)\b/.test(text)) {
    localSignals.add("concurrency");
  }
  if (/\b(std::move|&&|noexcept|operator=|~\w+\s*\()\b/.test(text)) localSignals.add("cpp");
  if (/#include\s*<bits\/stdc\+\+\.h>|#pragma|__attribute__|__declspec/.test(text)) {
    localSignals.add("compiler-specific");
  }
  if (/\b(map|set|list|collection|hashmap|hashset|arraylist|keyset|entryset|contains|add)\b/.test(text)) {
    localSignals.add("collection");
  }
  if (/\bstream\s*\(|\bstream<|\bcollectors\b/.test(text)) localSignals.add("stream");
  if (/\bserializable\b|\bserialversionuid\b|\btransient\b/.test(text)) localSignals.add("serialization");
  if (/\b(save|delete|insert|update|commit|rollback|persist|merge)\s*\(|\b(connection|preparedstatement|datasource|repository|transaction)\b/.test(text)) {
    localSignals.add("database-write");
  }

  return [...localSignals];
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function isCppPath(filePath: string): boolean {
  return /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(filePath);
}

function hasSpringSignals(signals: RuleSignals): boolean {
  if (hasEmfSignals(signals) && !/\bspring\b|org\.springframework/.test(signals.text)) {
    return false;
  }

  return (
    /org\.springframework|\bspringbootapplication\b|\bspringapplication\b|\bapplication\.(properties|yml|yaml)\b/.test(
      signals.text,
    ) ||
    /@(restcontroller|controller|service|repository|component|autowired|requestmapping|getmapping|postmapping|putmapping|deletemapping|patchmapping|transactional|preauthorize|postauthorize|secured)\b/.test(
      signals.text,
    ) ||
    /\bresponseentity\b|\bwebsecurityconfigureradapter\b|\bsecurityfilterchain\b/.test(signals.text) ||
    signals.signalNames.has("spring")
  );
}

function hasSpringSignalsFromText(text: string): boolean {
  return (
    /org\.springframework|\bspringbootapplication\b|\bspringapplication\b|\bapplication\.(properties|yml|yaml)\b/.test(text) ||
    /@(restcontroller|controller|service|repository|component|autowired|requestmapping|getmapping|postmapping|putmapping|deletemapping|patchmapping|transactional|preauthorize|postauthorize|secured)\b/.test(text) ||
    /\bresponseentity\b|\bwebsecurityconfigureradapter\b|\bsecurityfilterchain\b/.test(text)
  );
}

function hasJpaSignals(signals: RuleSignals): boolean {
  if (signals.signalNames.has("jpa")) return true;
  return hasJpaSignalsFromText(signals.text);
}

function hasJpaSignalsFromText(text: string): boolean {
  return (
    /jakarta\.persistence|javax\.persistence|org\.hibernate|springframework\.data\.jpa/.test(text) ||
    /@(entity|table|manytoone|onetomany|manytomany|onetoone|transactional)\b/.test(text) ||
    /\b(entitymanager|jparepository|crudrepository|lazy|fetchtype)\b/.test(text)
  );
}

function hasDatabaseWriteSignals(signals: RuleSignals): boolean {
  return /\b(save|delete|insert|update|commit|rollback|persist|merge)\s*\(|\b(connection|preparedstatement|datasource|repository|transaction)\b/.test(
    signals.text,
  );
}

function hasEmfSignals(signals: RuleSignals): boolean {
  return /org\.eclipse\.emf|\beobject\b|\belist\b|\beresource\b|\bresourceset\b|\beditingsupport\b/.test(
    signals.text,
  );
}

function hasReactSignals(signals: RuleSignals): boolean {
  if (signals.signalNames.has("react")) return true;
  return hasReactSignalsFromText(signals.filePath, signals.text);
}

function hasReactSignalsFromText(filePath: string, text: string): boolean {
  return (
    /\.(tsx|jsx)$/.test(filePath) ||
    /\bfrom\s+["']react["']|\brequire\s*\(\s*["']react["']\s*\)|\breact\./.test(text) ||
    /\b(useeffect|usestate|usememo|usecallback|useref|usecontext|usereducer)\s*\(/.test(text)
  );
}

function hasServerSignals(signals: RuleSignals): boolean {
  if (signals.signalNames.has("server")) return true;
  return hasServerSignalsFromText(signals.filePath, signals.text);
}

function hasServerSignalsFromText(filePath: string, text: string): boolean {
  return (
    /(^|\/)(server|api|routes|controllers|middleware)(\/|$)/.test(filePath) ||
    /\b(express|fastify|koa|hono|nestjs|nextrequest|requesthandler)\b/.test(text) ||
    /\b(req|request|res|response|ctx)\.(body|query|params|headers|cookies|ip)\b/.test(text) ||
    /\bprocess\.env\b/.test(text)
  );
}

function hasRequestInputSignals(signals: RuleSignals): boolean {
  return (
    hasServerSignals(signals) ||
    /\b(json\.parse|urlsearchparams|formdata|localstorage|sessionstorage)\b/.test(signals.text) ||
    /\b(body|query|params|headers|cookies)\b/.test(signals.text)
  );
}
