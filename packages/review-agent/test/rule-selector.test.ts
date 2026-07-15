import { describe, expect, it } from "vitest";
import type { RuleMap } from "@gitagents/core";
import { selectRelevantRules } from "../src/rule-selector";
import type { ProjectProfileDetection } from "../src/project-profile";

const rules: RuleMap = new Map(
  [
    "null-safety",
    "spring-security",
    "jpa-lazy-loading",
    "transaction-boundaries",
    "react-hooks",
    "server-side-security",
    "request-validation",
    "async-errors",
  ].map((ruleId) => [
    ruleId,
    {
      ruleId,
      severity: "error" as const,
      description: `${ruleId} rule`,
    },
  ]),
);

describe("selectRelevantRules", () => {
  it("does not include Spring/JPA-only checks for plain Java desktop code", () => {
    const selected = selectRelevantRules(rules, {
      filePath: "src/main/java/com/acme/DesktopAction.java",
      fileContent: "class DesktopAction { void run() { System.out.println(\"ok\"); } }",
      hybridContext: "+class DesktopAction {}",
    });

    expect(selected.has("null-safety")).toBe(true);
    expect(selected.has("spring-security")).toBe(false);
    expect(selected.has("jpa-lazy-loading")).toBe(false);
    expect(selected.has("transaction-boundaries")).toBe(false);
  });

  it("does not treat EMF Java projects as Spring projects", () => {
    const selected = selectRelevantRules(rules, {
      filePath: "src/model/TrainModel.java",
      fileContent: "import org.eclipse.emf.ecore.EObject; class TrainModel extends EObject {}",
      hybridContext: "+EObject train;",
      projectText: "src/model/TrainModel.java\n+import org.eclipse.emf.ecore.EObject;",
    });

    expect(selected.has("spring-security")).toBe(false);
  });

  it("includes Spring checks when Spring signals are present", () => {
    const selected = selectRelevantRules(rules, {
      filePath: "src/main/java/com/acme/UserController.java",
      fileContent: "import org.springframework.web.bind.annotation.RestController; @RestController class UserController {}",
      hybridContext: "+@GetMapping(\"/users/{id}\")",
    });

    expect(selected.has("spring-security")).toBe(true);
  });

  it("includes JPA checks when persistence signals are present", () => {
    const selected = selectRelevantRules(rules, {
      filePath: "src/main/java/com/acme/UserEntity.java",
      fileContent: "import jakarta.persistence.Entity; @Entity class UserEntity {}",
      hybridContext: "+@Entity",
    });

    expect(selected.has("jpa-lazy-loading")).toBe(true);
    expect(selected.has("transaction-boundaries")).toBe(true);
  });

  it("keeps React rules out of non-React TypeScript files", () => {
    const selected = selectRelevantRules(rules, {
      filePath: "src/math.ts",
      fileContent: "export function add(a: number, b: number) { return a + b; }",
      hybridContext: "+return a + b;",
    });

    expect(selected.has("react-hooks")).toBe(false);
    expect(selected.has("server-side-security")).toBe(false);
    expect(selected.has("request-validation")).toBe(false);
  });

  it("includes React and async rules when matching signals are present", () => {
    const selected = selectRelevantRules(rules, {
      filePath: "src/App.tsx",
      fileContent: "import React, { useEffect } from 'react'; export function App() { useEffect(async () => {}, []); }",
      hybridContext: "+useEffect(async () => {}, []);",
    });

    expect(selected.has("react-hooks")).toBe(true);
    expect(selected.has("async-errors")).toBe(true);
  });

  it("uses structured rule applicability metadata when present", () => {
    const springProfile: ProjectProfileDetection = {
      profiles: new Set(["spring-web"]),
      signals: new Set(["spring"]),
      evidence: ["test"],
    };
    const structuredRules: RuleMap = new Map([
      [
        "spring-security",
        {
          ruleId: "spring-security",
          severity: "error",
          description: "Spring security",
          applicability: { profiles: ["spring-web"], signals: ["spring"] },
        },
      ],
    ]);

    const selected = selectRelevantRules(structuredRules, {
      filePath: "src/main/java/com/acme/UserService.java",
      fileContent: "class UserService {}",
      hybridContext: "+class UserService {}",
      projectProfile: springProfile,
    });

    expect(selected.has("spring-security")).toBe(true);
  });

  it("skips structured Spring rules for plain Java profiles", () => {
    const plainProfile: ProjectProfileDetection = {
      profiles: new Set(["plain-java"]),
      signals: new Set(["java"]),
      evidence: ["test"],
    };
    const structuredRules: RuleMap = new Map([
      [
        "spring-security",
        {
          ruleId: "spring-security",
          severity: "error",
          description: "Spring security",
          applicability: { profiles: ["spring-web"], signals: ["spring"] },
        },
      ],
    ]);

    const selected = selectRelevantRules(structuredRules, {
      filePath: "src/main/java/com/acme/DesktopAction.java",
      fileContent: "class DesktopAction {}",
      hybridContext: "+class DesktopAction {}",
      projectProfile: plainProfile,
    });

    expect(selected.has("spring-security")).toBe(false);
  });

  it("requires all required signals for structured applicability", () => {
    const structuredRules: RuleMap = new Map([
      [
        "callback-promise-mismatch",
        {
          ruleId: "callback-promise-mismatch",
          severity: "error",
          description: "Async callback mismatch",
          applicability: { signals: ["callback"], requiredSignals: ["async"] },
        },
      ],
    ]);

    const callbackOnly = selectRelevantRules(structuredRules, {
      filePath: "src/app.ts",
      fileContent: "items.forEach((item) => handle(item));",
      hybridContext: "+items.forEach((item) => handle(item));",
    });
    const asyncCallback = selectRelevantRules(structuredRules, {
      filePath: "src/app.ts",
      fileContent: "items.forEach(async (item) => handle(item));",
      hybridContext: "+items.forEach(async (item) => handle(item));",
    });

    expect(callbackOnly.has("callback-promise-mismatch")).toBe(false);
    expect(asyncCallback.has("callback-promise-mismatch")).toBe(true);
  });

  it("selects C/C++ rules from pointer and buffer signals", () => {
    const cppRules: RuleMap = new Map([
      [
        "memory-lifetime",
        {
          ruleId: "memory-lifetime",
          severity: "error",
          description: "Memory lifetime",
          applicability: { signals: ["pointer", "ownership", "raw-memory"] },
        },
      ],
      [
        "buffer-bounds",
        {
          ruleId: "buffer-bounds",
          severity: "error",
          description: "Buffer bounds",
          applicability: { signals: ["buffer", "c-string", "raw-memory"] },
        },
      ],
    ]);

    const selected = selectRelevantRules(cppRules, {
      filePath: "src/parser.cpp",
      fileContent: "char buffer[32]; strcpy(buffer, input); auto value = node->value;",
      hybridContext: "+strcpy(buffer, input);",
    });

    expect(selected.has("memory-lifetime")).toBe(true);
    expect(selected.has("buffer-bounds")).toBe(true);
  });
});
