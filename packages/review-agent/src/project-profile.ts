import type { FileDiff, RepoRef } from "@gitagents/forge";

export type ProjectProfile =
  | "spring-web"
  | "plain-java"
  | "emf-desktop"
  | "node-server"
  | "react-ui"
  | "native-cpp"
  | "library";

export interface ProjectProfileDetection {
  profiles: Set<ProjectProfile>;
  signals: Set<string>;
  evidence: string[];
}

export interface ProjectProfileInput {
  diffs: FileDiff[];
  manifestContents?: Record<string, string>;
}

export interface ManifestReader {
  getFileContent(repo: RepoRef, filePath: string, ref: string): Promise<string>;
}

const MANIFEST_PATHS = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "package.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "CMakeLists.txt",
  "Makefile",
  "makefile",
  "meson.build",
  "conanfile.txt",
  "vcpkg.json",
];

export async function detectProjectProfileFromRepository(input: {
  diffs: FileDiff[];
  reader: ManifestReader;
  repo: RepoRef;
  ref: string;
}): Promise<ProjectProfileDetection> {
  const manifestContents: Record<string, string> = {};

  await Promise.all(
    MANIFEST_PATHS.map(async (filePath) => {
      try {
        manifestContents[filePath] = await input.reader.getFileContent(
          input.repo,
          filePath,
          input.ref,
        );
      } catch {
        // Optional project metadata. Absence is not a review error.
      }
    }),
  );

  return detectProjectProfile({
    diffs: input.diffs,
    manifestContents,
  });
}

export function detectProjectProfile(input: ProjectProfileInput): ProjectProfileDetection {
  const text = normalize(
    [
      ...input.diffs.map((diff) => `${diff.newPath}\n${diff.diff}`),
      ...Object.entries(input.manifestContents ?? {}).map(
        ([filePath, content]) => `${filePath}\n${content}`,
      ),
    ].join("\n"),
  );
  const profiles = new Set<ProjectProfile>();
  const signals = new Set<string>();
  const evidence: string[] = [];

  addLanguageSignals(text, signals);

  if (hasSpring(text)) {
    profiles.add("spring-web");
    signals.add("spring");
    signals.add("server");
    evidence.push("Spring framework indicators");
  }

  if (hasEmf(text)) {
    profiles.add("emf-desktop");
    signals.add("emf");
    evidence.push("Eclipse EMF indicators");
  }

  if (hasReact(text)) {
    profiles.add("react-ui");
    signals.add("react");
    evidence.push("React indicators");
  }

  if (hasNodeServer(text)) {
    profiles.add("node-server");
    signals.add("server");
    evidence.push("Node/server indicators");
  }

  if (hasCpp(text)) {
    profiles.add("native-cpp");
    signals.add("cpp");
    signals.add("c-cpp");
    evidence.push("C/C++ source or build indicators");
  }

  if (hasJpa(text)) {
    signals.add("jpa");
    evidence.push("JPA/Hibernate indicators");
  }

  if (hasJava(text) && !profiles.has("spring-web") && !profiles.has("emf-desktop")) {
    profiles.add("plain-java");
    evidence.push("Java code without Spring/EMF project indicators");
  }

  if (profiles.size === 0 || looksLikeLibrary(text)) {
    profiles.add("library");
  }

  return { profiles, signals, evidence };
}

function addLanguageSignals(text: string, signals: Set<string>): void {
  if (hasJava(text)) signals.add("java");
  if (hasCpp(text)) {
    signals.add("cpp");
    signals.add("c-cpp");
  }
  if (/\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)\b/.test(text) || /\btypescript\b|\bjavascript\b/.test(text)) {
    signals.add("typescript");
  }
}

function hasJava(text: string): boolean {
  return /\.java\b|pom\.xml|build\.gradle|build\.gradle\.kts|\bjava\b/.test(text);
}

function hasSpring(text: string): boolean {
  return (
    /org\.springframework|\bspring-boot\b|\bspringframework\b|\bspringbootapplication\b/.test(text) ||
    /@(restcontroller|controller|service|repository|component|autowired|requestmapping|getmapping|postmapping|putmapping|deletemapping|patchmapping|transactional|preauthorize|postauthorize|secured)\b/.test(text)
  );
}

function hasJpa(text: string): boolean {
  return (
    /jakarta\.persistence|javax\.persistence|org\.hibernate|springframework\.data\.jpa/.test(text) ||
    /@(entity|table|manytoone|onetomany|manytomany|onetoone)\b/.test(text) ||
    /\b(entitymanager|jparepository|crudrepository|fetchtype)\b/.test(text)
  );
}

function hasEmf(text: string): boolean {
  return /org\.eclipse\.emf|\beobject\b|\belist\b|\beresource\b|\bresourceset\b/.test(text);
}

function hasReact(text: string): boolean {
  return (
    /\breact\b|@vitejs\/plugin-react|next\b/.test(text) ||
    /\.(tsx|jsx)\b/.test(text) ||
    /\b(useeffect|usestate|usecontext|usereducer|useref)\s*\(/.test(text)
  );
}

function hasNodeServer(text: string): boolean {
  return (
    /\b(express|fastify|koa|nestjs|hono)\b/.test(text) ||
    /(^|\/)(server|api|routes|controllers|middleware)(\/|$)/.test(text) ||
    /\b(req|request|ctx)\.(body|query|params|headers|cookies)\b/.test(text)
  );
}

function hasCpp(text: string): boolean {
  return (
    /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)\b/.test(text) ||
    /\b(cmakelists\.txt|cmake|meson\.build|conanfile\.txt|vcpkg\.json)\b/.test(text) ||
    /#include\s*[<"][^>"]+[>"]/.test(text)
  );
}

function looksLikeLibrary(text: string): boolean {
  return /\bmain\b|\bexports\b|\btypes\b|\bmodule\b/.test(text);
}

function normalize(text: string): string {
  return text.toLowerCase();
}
