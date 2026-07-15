import { describe, expect, it } from "vitest";
import { detectProjectProfile } from "../src/project-profile";
import type { FileDiff } from "@gitagents/core";

describe("detectProjectProfile", () => {
  it("detects Spring web projects from manifests", () => {
    const profile = detectProjectProfile({
      diffs: [],
      manifestContents: {
        "pom.xml": "<artifactId>spring-boot-starter-web</artifactId>",
      },
    });

    expect(profile.profiles.has("spring-web")).toBe(true);
    expect(profile.signals.has("spring")).toBe(true);
  });

  it("detects EMF desktop projects without marking them Spring", () => {
    const profile = detectProjectProfile({
      diffs: [
        {
          oldPath: "src/model/Train.java",
          newPath: "src/model/Train.java",
          deletedFile: false,
          newFile: false,
          renamedFile: false,
          diff: "+import org.eclipse.emf.ecore.EObject;",
        } satisfies FileDiff,
      ],
    });

    expect(profile.profiles.has("emf-desktop")).toBe(true);
    expect(profile.profiles.has("spring-web")).toBe(false);
  });

  it("detects React and Node server profiles", () => {
    const profile = detectProjectProfile({
      diffs: [
        {
          oldPath: "src/App.tsx",
          newPath: "src/App.tsx",
          deletedFile: false,
          newFile: false,
          renamedFile: false,
          diff: "+import React from 'react';",
        } satisfies FileDiff,
        {
          oldPath: "src/server/routes/user.ts",
          newPath: "src/server/routes/user.ts",
          deletedFile: false,
          newFile: false,
          renamedFile: false,
          diff: "+app.get('/users/:id', (req, res) => res.json(req.params));",
        } satisfies FileDiff,
      ],
    });

    expect(profile.profiles.has("react-ui")).toBe(true);
    expect(profile.profiles.has("node-server")).toBe(true);
  });

  it("detects native C/C++ projects", () => {
    const profile = detectProjectProfile({
      diffs: [
        {
          oldPath: "src/main.cpp",
          newPath: "src/main.cpp",
          deletedFile: false,
          newFile: false,
          renamedFile: false,
          diff: "+#include <vector>",
        } satisfies FileDiff,
      ],
      manifestContents: {
        "CMakeLists.txt": "add_executable(app src/main.cpp)",
      },
    });

    expect(profile.profiles.has("native-cpp")).toBe(true);
    expect(profile.signals.has("c-cpp")).toBe(true);
  });
});
