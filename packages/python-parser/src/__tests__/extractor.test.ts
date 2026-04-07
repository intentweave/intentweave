// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Python AST extractor.
 */

import { describe, it, expect } from "vitest";
import { PythonExtractor } from "../extractor.js";

const extractor = new PythonExtractor("/workspace", {
  includePrivate: true,
  includeDocSummary: true,
  includeParameters: true,
  includeMembers: true,
  maxDepth: 3,
});

function extract(source: string, filePath = "test.py") {
  return extractor.extractFromString(source, filePath);
}

// =============================================================================
// Functions
// =============================================================================

describe("Python Extractor — Functions", () => {
  it("extracts a simple function", () => {
    const result = extract(`
def greet(name):
    return f"Hello, {name}"
`);
    expect(result.symbols).toHaveLength(1);
    const fn = result.symbols[0];
    expect(fn.name).toBe("greet");
    expect(fn.kind).toBe("function");
    expect(fn.isExported).toBe(true);
    expect(fn.parameters).toEqual(["name"]);
  });

  it("extracts async function", () => {
    const result = extract(`
async def fetch_data(url):
    pass
`);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe("fetch_data");
    expect(result.symbols[0].isAsync).toBe(true);
  });

  it("extracts function with type hints and default params", () => {
    const result = extract(`
def process(data: list, count: int = 10, *args, **kwargs):
    pass
`);
    const fn = result.symbols[0];
    expect(fn.parameters).toEqual(["data", "count", "*args", "**kwargs"]);
  });

  it("extracts function with docstring", () => {
    const result = extract(`
def compute(x):
    """Compute the result for x."""
    return x * 2
`);
    expect(result.symbols[0].docSummary).toBe("Compute the result for x.");
  });

  it("extracts function signature", () => {
    const result = extract(`
def add(a: int, b: int) -> int:
    return a + b
`);
    expect(result.symbols[0].signature).toContain("def add");
  });

  it("marks _private functions as internal", () => {
    const result = extract(`
def _helper():
    pass
`);
    expect(result.symbols[0].isExported).toBe(false);
    expect(result.symbols[0].visibility).toBe("protected");
  });

  it("marks __dunder as private visibility", () => {
    const result = extract(`
def __secret():
    pass
`);
    expect(result.symbols[0].visibility).toBe("private");
  });
});

// =============================================================================
// Classes
// =============================================================================

describe("Python Extractor — Classes", () => {
  it("extracts a simple class", () => {
    const result = extract(`
class User:
    pass
`);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe("User");
    expect(result.symbols[0].kind).toBe("class");
    expect(result.symbols[0].isExported).toBe(true);
  });

  it("extracts class with base classes", () => {
    const result = extract(`
class Admin(User, PermissionMixin):
    pass
`);
    expect(result.symbols[0].bases).toEqual(["User", "PermissionMixin"]);
  });

  it("extracts class with docstring", () => {
    const result = extract(`
class Service:
    """The main service class."""
    pass
`);
    expect(result.symbols[0].docSummary).toBe("The main service class.");
  });

  it("extracts methods within a class", () => {
    const result = extract(`
class Calculator:
    def add(self, a, b):
        return a + b

    def subtract(self, a, b):
        return a - b
`);
    // class + 2 methods
    expect(result.symbols).toHaveLength(3);
    expect(result.symbols[0].kind).toBe("class");
    expect(result.symbols[1].kind).toBe("method");
    expect(result.symbols[1].name).toBe("add");
    expect(result.symbols[1].parent).toBe("Calculator");
    expect(result.symbols[2].kind).toBe("method");
    expect(result.symbols[2].name).toBe("subtract");
  });

  it("handles @staticmethod and @classmethod", () => {
    const result = extract(`
class MyClass:
    @staticmethod
    def from_string(s):
        pass

    @classmethod
    def create(cls):
        pass
`);
    const methods = result.symbols.filter((s) => s.kind === "method");
    expect(methods).toHaveLength(2);
    expect(methods[0].decorators).toContain("staticmethod");
    expect(methods[0].isStatic).toBe(true);
    expect(methods[1].decorators).toContain("classmethod");
    expect(methods[1].isStatic).toBe(true);
  });

  it("handles @property as property kind", () => {
    const result = extract(`
class Config:
    @property
    def name(self):
        return self._name
`);
    const prop = result.symbols.find((s) => s.kind === "property");
    expect(prop).toBeDefined();
    expect(prop!.name).toBe("name");
    expect(prop!.decorators).toContain("property");
  });
});

// =============================================================================
// Decorators
// =============================================================================

describe("Python Extractor — Decorators", () => {
  it("extracts decorator on function", () => {
    const result = extract(`
@app.route("/")
def index():
    pass
`);
    expect(result.symbols[0].decorators).toEqual(["app.route"]);
  });

  it("extracts multiple decorators", () => {
    const result = extract(`
@login_required
@cache(timeout=300)
def dashboard():
    pass
`);
    expect(result.symbols[0].decorators).toEqual(["login_required", "cache"]);
  });

  it("extracts decorator on class", () => {
    const result = extract(`
@dataclass
class Point:
    x: float
    y: float
`);
    expect(result.symbols[0].decorators).toEqual(["dataclass"]);
  });
});

// =============================================================================
// Imports
// =============================================================================

describe("Python Extractor — Imports", () => {
  it("extracts import statement", () => {
    const result = extract(`
import os
import sys
`);
    expect(result.imports).toHaveLength(2);
    expect(result.imports[0].moduleName).toBe("os");
    expect(result.imports[0].isRelative).toBe(false);
    expect(result.imports[0].isWholeModule).toBe(true);
    expect(result.imports[1].moduleName).toBe("sys");
  });

  it("extracts import with alias", () => {
    const result = extract(`
import numpy as np
`);
    expect(result.imports[0].moduleName).toBe("numpy");
    expect(result.imports[0].alias).toBe("np");
  });

  it("extracts from...import statement", () => {
    const result = extract(`
from os.path import join, dirname
`);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].moduleName).toBe("os.path");
    expect(result.imports[0].isWholeModule).toBe(false);
    expect(result.imports[0].importedNames).toEqual([
      { name: "join" },
      { name: "dirname" },
    ]);
  });

  it("extracts from...import with alias", () => {
    const result = extract(`
from collections import OrderedDict as ODict
`);
    expect(result.imports[0].importedNames).toEqual([
      { name: "OrderedDict", alias: "ODict" },
    ]);
  });

  it("extracts relative import", () => {
    const result = extract(`
from .utils import helper
from ..models import User
`);
    expect(result.imports).toHaveLength(2);
    expect(result.imports[0].isRelative).toBe(true);
    expect(result.imports[0].importedNames).toEqual([{ name: "helper" }]);
    expect(result.imports[1].isRelative).toBe(true);
    expect(result.imports[1].importedNames).toEqual([{ name: "User" }]);
  });

  it("extracts wildcard import", () => {
    const result = extract(`
from os.path import *
`);
    expect(result.imports[0].importedNames).toEqual([{ name: "*" }]);
  });
});

// =============================================================================
// Module-Level Variables
// =============================================================================

describe("Python Extractor — Variables", () => {
  it("extracts module-level constant", () => {
    const result = extract(`
MAX_RETRIES = 3
DEFAULT_TIMEOUT = 30
`);
    const vars = result.symbols.filter((s) => s.kind === "variable");
    expect(vars).toHaveLength(2);
    expect(vars[0].name).toBe("MAX_RETRIES");
    expect(vars[0].isExported).toBe(true);
    expect(vars[1].name).toBe("DEFAULT_TIMEOUT");
  });

  it("skips __all__ as a symbol", () => {
    const result = extract(`
__all__ = ["foo", "bar"]
`);
    expect(result.symbols).toHaveLength(0);
  });

  it("marks _private variables as internal", () => {
    const result = extract(`
_internal_cache = {}
`);
    expect(result.symbols[0].isExported).toBe(false);
    expect(result.symbols[0].visibility).toBe("protected");
  });
});

// =============================================================================
// __all__ Handling
// =============================================================================

describe("Python Extractor — __all__", () => {
  it("uses __all__ to determine exports", () => {
    const result = extract(`
__all__ = ["greet", "User"]

def greet():
    pass

def _helper():
    pass

class User:
    pass

class _Internal:
    pass
`);
    const greet = result.symbols.find((s) => s.name === "greet");
    const helper = result.symbols.find((s) => s.name === "_helper");
    const user = result.symbols.find((s) => s.name === "User");
    const internal = result.symbols.find((s) => s.name === "_Internal");

    expect(greet!.isExported).toBe(true);
    expect(helper!.isExported).toBe(false);
    expect(user!.isExported).toBe(true);
    expect(internal!.isExported).toBe(false);
  });
});

// =============================================================================
// Source Location
// =============================================================================

describe("Python Extractor — Source Ranges", () => {
  it("reports correct 1-based line numbers", () => {
    const result = extract(`
def first():
    pass

def second():
    pass
`);
    expect(result.symbols[0].range.startLine).toBe(2);
    expect(result.symbols[1].range.startLine).toBe(5);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("Python Extractor — Edge Cases", () => {
  it("handles empty file", () => {
    const result = extract("");
    expect(result.symbols).toHaveLength(0);
    expect(result.imports).toHaveLength(0);
  });

  it("handles file with only comments", () => {
    const result = extract(`
# This is a comment
# Another comment
`);
    expect(result.symbols).toHaveLength(0);
  });

  it("handles nested classes", () => {
    const result = extract(`
class Outer:
    class Inner:
        def method(self):
            pass
`);
    const outer = result.symbols.find((s) => s.name === "Outer");
    const inner = result.symbols.find((s) => s.name === "Inner");
    const method = result.symbols.find((s) => s.name === "method");

    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(method).toBeDefined();
    expect(method!.parent).toBe("Inner");
  });

  it("respects maxDepth", () => {
    const shallowExtractor = new PythonExtractor("/workspace", {
      includePrivate: true,
      maxDepth: 0,
    });
    const result = shallowExtractor.extractFromString(
      `
class Outer:
    def method(self):
        pass
`,
      "test.py",
    );
    // maxDepth=0 means only module-level
    // The class itself appears but its body won't be walked
    // Actually with the walk at depth 0, we see module children
    // But class body walk is depth+1 = 1 which is > maxDepth=0
    const methods = result.symbols.filter((s) => s.kind === "method");
    expect(methods).toHaveLength(0);
  });

  it("sets filePath on all symbols", () => {
    const result = extract(
      `
def foo():
    pass

class Bar:
    pass
`,
      "my/module.py",
    );
    for (const sym of result.symbols) {
      expect(sym.filePath).toBe("my/module.py");
    }
  });

  it("reports parse errors but still extracts what it can", () => {
    const result = extract(`
def valid():
    pass

def broken(
`);
    expect(result.errors).toBeDefined();
    // Should still extract the valid function
    const valid = result.symbols.find((s) => s.name === "valid");
    expect(valid).toBeDefined();
  });

  it("excludes private symbols when includePrivate=false", () => {
    const publicExtractor = new PythonExtractor("/workspace", {
      includePrivate: false,
    });
    const result = publicExtractor.extractFromString(
      `
def public_fn():
    pass

def _private_fn():
    pass

class PublicClass:
    pass

class _PrivateClass:
    pass
`,
      "test.py",
    );
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain("public_fn");
    expect(names).not.toContain("_private_fn");
    expect(names).toContain("PublicClass");
    expect(names).not.toContain("_PrivateClass");
  });
});

// =============================================================================
// Batch Extraction
// =============================================================================

describe("Python Extractor — Language / metadata", () => {
  it("reports language as python", () => {
    const result = extract("x = 1");
    expect(result.language).toBe("python");
  });

  it("sets extractedAt timestamp", () => {
    const before = Date.now();
    const result = extract("x = 1");
    expect(result.extractedAt).toBeGreaterThanOrEqual(before);
  });
});
