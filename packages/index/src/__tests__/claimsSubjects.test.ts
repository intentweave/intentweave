// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  SUBJECT_IDENTITY_CONTRACT_VERSION,
  parameterSubjectIdentity,
} from "../claims/subjects.js";

describe("SubjectIdentity v1", () => {
  it("maps a Parameter identity to a path-independent golden Subject", () => {
    expect(parameterSubjectIdentity("session.timeout")).toEqual({
      id: "subject:7b57ba0a2670daa7bc027664d912ee37df1cd3a49351a929bbc73dc8599c91bc",
      kind: "parameter",
      identityKey: "parameter:session.timeout",
      displayName: "session.timeout",
      lifecycleState: "active",
      contractVersion: "1",
    });
    expect(SUBJECT_IDENTITY_CONTRACT_VERSION).toBe("1");
  });

  it("rejects an empty Parameter identity", () => {
    expect(() => parameterSubjectIdentity("  ")).toThrow("non-empty key");
  });
});
