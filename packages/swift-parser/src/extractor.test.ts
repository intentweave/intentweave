// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "vitest";
import { SwiftExtractor } from "./extractor.js";
import type { SwiftSymbol, SwiftImport } from "./types.js";

describe("SwiftExtractor", () => {
  let extractor: SwiftExtractor;

  beforeEach(() => {
    extractor = new SwiftExtractor("/tmp/test-workspace");
  });

  // ── Imports ────────────────────────────────────────────────────────────

  describe("imports", () => {
    it("extracts simple imports", () => {
      const result = extractor.extractFromString(
        `import Foundation\nimport SwiftUI`,
        "test.swift",
      );

      expect(result.imports).toHaveLength(2);
      expect(result.imports[0].moduleName).toBe("Foundation");
      expect(result.imports[1].moduleName).toBe("SwiftUI");
    });

    it("extracts language is swift", () => {
      const result = extractor.extractFromString(
        "import Foundation",
        "test.swift",
      );
      expect(result.language).toBe("swift");
    });
  });

  // ── Structs ────────────────────────────────────────────────────────────

  describe("structs", () => {
    it("extracts struct with properties", () => {
      const result = extractor.extractFromString(
        `struct Point {
    let x: Double
    let y: Double
}`,
        "test.swift",
      );

      const struct = result.symbols.find(
        (s) => s.kind === "struct" && s.name === "Point",
      );
      expect(struct).toBeDefined();
      expect(struct!.isExported).toBe(false);

      const props = result.symbols.filter(
        (s) => s.kind === "property" && s.parent === "Point",
      );
      expect(props).toHaveLength(2);
      expect(props.map((p) => p.name)).toContain("x");
      expect(props.map((p) => p.name)).toContain("y");
    });

    it("extracts struct conformances", () => {
      const result = extractor.extractFromString(
        `struct Task: Identifiable, Codable {
    let id: String
}`,
        "test.swift",
      );

      const struct = result.symbols.find((s) => s.kind === "struct");
      expect(struct?.conformances).toEqual(["Identifiable", "Codable"]);
    });
  });

  // ── Classes ────────────────────────────────────────────────────────────

  describe("classes", () => {
    it("extracts class with superclass and conformances", () => {
      const result = extractor.extractFromString(
        `open class ViewModel: ObservableObject, Identifiable {
    public let id: String
    public func load() async throws {}
}`,
        "test.swift",
      );

      const cls = result.symbols.find((s) => s.kind === "class");
      expect(cls).toBeDefined();
      expect(cls!.name).toBe("ViewModel");
      expect(cls!.isExported).toBe(true);
      expect(cls!.accessControl).toBe("open");
      expect(cls!.superclass).toBe("ObservableObject");
      expect(cls!.conformances).toEqual(["Identifiable"]);
    });

    it("extracts methods within a class", () => {
      const result = extractor.extractFromString(
        `class Service {
    func fetch() async throws -> [String] { [] }
    static func shared() -> Service { Service() }
}`,
        "test.swift",
      );

      const methods = result.symbols.filter(
        (s) => s.kind === "method" && s.parent === "Service",
      );
      expect(methods).toHaveLength(2);

      const fetch = methods.find((m) => m.name === "fetch");
      expect(fetch?.isAsync).toBe(true);
      expect(fetch?.isThrowing).toBe(true);
      expect(fetch?.isStatic).toBe(false);

      const shared = methods.find((m) => m.name === "shared");
      expect(shared?.isStatic).toBe(true);
    });

    it("extracts initializer", () => {
      const result = extractor.extractFromString(
        `class Foo {
    let x: Int
    init(x: Int) {
        self.x = x
    }
}`,
        "test.swift",
      );

      const init = result.symbols.find((s) => s.kind === "initializer");
      expect(init).toBeDefined();
      expect(init!.name).toBe("init");
      expect(init!.parent).toBe("Foo");
      expect(init!.parameters).toEqual(["x"]);
    });
  });

  // ── Protocols ──────────────────────────────────────────────────────────

  describe("protocols", () => {
    it("extracts protocol with requirements", () => {
      const result = extractor.extractFromString(
        `protocol Repository {
    func findAll() async throws -> [String]
    var count: Int { get }
}`,
        "test.swift",
      );

      const proto = result.symbols.find((s) => s.kind === "protocol");
      expect(proto).toBeDefined();
      expect(proto!.name).toBe("Repository");

      const method = result.symbols.find(
        (s) => s.kind === "method" && s.parent === "Repository",
      );
      expect(method?.name).toBe("findAll");
      expect(method?.isAsync).toBe(true);
    });

    it("extracts protocol inheritance", () => {
      const result = extractor.extractFromString(
        `protocol Storable: Codable, Identifiable {}`,
        "test.swift",
      );

      const proto = result.symbols.find((s) => s.kind === "protocol");
      expect(proto?.conformances).toEqual(["Codable", "Identifiable"]);
    });
  });

  // ── Enums ──────────────────────────────────────────────────────────────

  describe("enums", () => {
    it("extracts enum declaration", () => {
      const result = extractor.extractFromString(
        `enum Direction: String {
    case north, south, east, west
}`,
        "test.swift",
      );

      const enumSym = result.symbols.find((s) => s.kind === "enum");
      expect(enumSym).toBeDefined();
      expect(enumSym!.name).toBe("Direction");
      expect(enumSym!.conformances).toEqual(["String"]);
    });
  });

  // ── Extensions ─────────────────────────────────────────────────────────

  describe("extensions", () => {
    it("extracts extension with conformance", () => {
      const result = extractor.extractFromString(
        `extension String: CustomStringConvertible {
    var description: String { self }
}`,
        "test.swift",
      );

      const ext = result.symbols.find((s) => s.kind === "extension");
      expect(ext).toBeDefined();
      expect(ext!.name).toBe("String");
      expect(ext!.extendedType).toBe("String");
      expect(ext!.conformances).toEqual(["CustomStringConvertible"]);
    });
  });

  // ── Top-level functions ────────────────────────────────────────────────

  describe("top-level functions", () => {
    it("extracts top-level async throwing function", () => {
      const result = extractor.extractFromString(
        `func process(items: [String], limit: Int) async throws -> [String] {
    return items
}`,
        "test.swift",
      );

      const fn = result.symbols.find((s) => s.kind === "function");
      expect(fn).toBeDefined();
      expect(fn!.name).toBe("process");
      expect(fn!.isAsync).toBe(true);
      expect(fn!.isThrowing).toBe(true);
      expect(fn!.parent).toBeUndefined();
      expect(fn!.parameters).toEqual(["items", "limit"]);
    });
  });

  // ── Typealias ──────────────────────────────────────────────────────────

  describe("typealias", () => {
    it("extracts typealias", () => {
      const result = extractor.extractFromString(
        `typealias Callback = (String) -> Void`,
        "test.swift",
      );

      const ta = result.symbols.find((s) => s.kind === "typealias");
      expect(ta).toBeDefined();
      expect(ta!.name).toBe("Callback");
    });
  });

  // ── Access control ─────────────────────────────────────────────────────

  describe("access control", () => {
    it("filters out private symbols by default", () => {
      const result = extractor.extractFromString(
        `class Foo {
    public let x: Int = 0
    private let y: Int = 0
    internal let z: Int = 0
}`,
        "test.swift",
      );

      const props = result.symbols.filter((s) => s.kind === "property");
      const names = props.map((p) => p.name);
      expect(names).toContain("x");
      expect(names).not.toContain("y");
      expect(names).toContain("z");
    });

    it("includes private symbols when option is set", () => {
      const privateExtractor = new SwiftExtractor("/tmp/test", {
        includePrivate: true,
      });
      const result = privateExtractor.extractFromString(
        `class Foo {
    private let secret: String = ""
}`,
        "test.swift",
      );

      const secretProp = result.symbols.find(
        (s) => s.kind === "property" && s.name === "secret",
      );
      expect(secretProp).toBeDefined();
      expect(secretProp!.accessControl).toBe("private");
    });

    it("marks public/open as exported", () => {
      const result = extractor.extractFromString(
        `public struct Foo {}
open class Bar {}
struct Baz {}`,
        "test.swift",
      );

      const foo = result.symbols.find((s) => s.name === "Foo");
      expect(foo?.isExported).toBe(true);
      const bar = result.symbols.find((s) => s.name === "Bar");
      expect(bar?.isExported).toBe(true);
      const baz = result.symbols.find((s) => s.name === "Baz");
      expect(baz?.isExported).toBe(false);
    });
  });

  // ── Source ranges ──────────────────────────────────────────────────────

  describe("source ranges", () => {
    it("provides correct 1-based line numbers", () => {
      const result = extractor.extractFromString(
        `import Foundation

struct Point {
    let x: Double
}`,
        "test.swift",
      );

      const struct = result.symbols.find((s) => s.kind === "struct");
      expect(struct?.range.startLine).toBe(3);
    });
  });

  // ── Batch extraction ──────────────────────────────────────────────────

  describe("batch extraction", () => {
    it("reports failures gracefully", async () => {
      const result = await extractor.extractBatch([
        "/tmp/test-workspace/nonexistent.swift",
      ]);

      expect(result.totalFiles).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].error).toContain("ENOENT");
    });
  });

  // ── Complex real-world example ─────────────────────────────────────────

  describe("real-world Swift code", () => {
    it("extracts a full SwiftUI view model + view", () => {
      const source = `
import SwiftUI
import Combine

/// Main view model for task management
public class TaskViewModel: ObservableObject {
    @Published var tasks: [Task] = []
    @Published private(set) var isLoading = false

    private let repository: TaskRepository

    init(repository: TaskRepository) {
        self.repository = repository
    }

    func loadTasks() async throws {
        isLoading = true
        defer { isLoading = false }
        tasks = try await repository.fetchAll()
    }

    func addTask(_ task: Task) async throws {
        try await repository.save(task)
        tasks.append(task)
    }
}

struct TaskListView: View {
    @StateObject private var viewModel = TaskViewModel(repository: InMemoryRepository())

    var body: some View {
        List(viewModel.tasks) { task in
            TaskRow(task: task)
        }
    }
}
`;

      const result = extractor.extractFromString(
        source,
        "Sources/TaskView.swift",
      );

      // Imports
      expect(result.imports).toHaveLength(2);
      expect(result.imports.map((i) => i.moduleName)).toEqual([
        "SwiftUI",
        "Combine",
      ]);

      // Class
      const vm = result.symbols.find(
        (s) => s.kind === "class" && s.name === "TaskViewModel",
      );
      expect(vm).toBeDefined();
      expect(vm!.isExported).toBe(true);
      expect(vm!.superclass).toBe("ObservableObject");

      // Struct
      const view = result.symbols.find(
        (s) => s.kind === "struct" && s.name === "TaskListView",
      );
      expect(view).toBeDefined();

      // Methods
      const methods = result.symbols.filter(
        (s) => s.kind === "method" && s.parent === "TaskViewModel",
      );
      const methodNames = methods.map((m) => m.name);
      expect(methodNames).toContain("loadTasks");
      expect(methodNames).toContain("addTask");

      // Initializer
      const init = result.symbols.find(
        (s) => s.kind === "initializer" && s.parent === "TaskViewModel",
      );
      expect(init).toBeDefined();
      expect(init!.parameters).toEqual(["repository"]);

      // No errors
      expect(result.errors).toBeUndefined();
    });
  });
});
