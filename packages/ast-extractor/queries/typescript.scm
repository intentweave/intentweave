; =============================================================================
; TypeScript/JavaScript Tree-Sitter Queries for AST Extraction
; =============================================================================
; These queries extract structural symbols from TypeScript/JavaScript code.
; Focus: Functions, classes, interfaces, types, exports, imports
; =============================================================================

; -----------------------------------------------------------------------------
; FUNCTION DECLARATIONS
; -----------------------------------------------------------------------------

; Regular function declarations
(function_declaration
  name: (identifier) @function.name
) @function

; Arrow function assigned to variable
(lexical_declaration
  (variable_declarator
    name: (identifier) @function.name
    value: (arrow_function)
  )
) @arrow_function

; Function expression assigned to variable
(lexical_declaration
  (variable_declarator
    name: (identifier) @function.name
    value: (function_expression)
  )
) @function_expression

; Async function declarations
(function_declaration
  "async" @function.async
  name: (identifier) @function.name
) @async_function

; Generator functions
(generator_function_declaration
  name: (identifier) @function.name
) @generator_function

; -----------------------------------------------------------------------------
; CLASS DECLARATIONS
; -----------------------------------------------------------------------------

; Class declaration
(class_declaration
  name: (type_identifier) @class.name
  (class_heritage
    (extends_clause
      value: (_) @class.extends
    )?
    (implements_clause
      (type_identifier) @class.implements
    )*
  )?
) @class

; Class methods
(class_body
  (method_definition
    name: (property_identifier) @method.name
  ) @method
)

; Class constructor
(class_body
  (method_definition
    name: "constructor" @constructor.name
  ) @constructor
)

; Class properties
(class_body
  (public_field_definition
    name: (property_identifier) @property.name
  ) @property
)

; Static members
(class_body
  (method_definition
    "static" @member.static
    name: (property_identifier) @method.name
  ) @static_method
)

; Getters and setters
(class_body
  (method_definition
    "get" @accessor.get
    name: (property_identifier) @getter.name
  ) @getter
)

(class_body
  (method_definition
    "set" @accessor.set
    name: (property_identifier) @setter.name
  ) @setter
)

; -----------------------------------------------------------------------------
; INTERFACE DECLARATIONS (TypeScript)
; -----------------------------------------------------------------------------

; Interface declaration
(interface_declaration
  name: (type_identifier) @interface.name
) @interface

; Interface heritage (extends)
(interface_declaration
  name: (type_identifier) @interface.name
  (extends_type_clause
    (type_identifier) @interface.extends
  )?
) @interface_with_heritage

; Interface method signatures
(interface_body
  (method_signature
    name: (property_identifier) @interface_method.name
  ) @interface_method
)

; Interface properties
(interface_body
  (property_signature
    name: (property_identifier) @interface_property.name
  ) @interface_property
)

; -----------------------------------------------------------------------------
; TYPE DECLARATIONS (TypeScript)
; -----------------------------------------------------------------------------

; Type alias
(type_alias_declaration
  name: (type_identifier) @type.name
) @type_alias

; Enum declaration
(enum_declaration
  name: (identifier) @enum.name
) @enum

; Enum members
(enum_body
  (property_identifier) @enum_member.name
) @enum_member

; -----------------------------------------------------------------------------
; VARIABLE DECLARATIONS
; -----------------------------------------------------------------------------

; const/let/var declarations
(lexical_declaration
  (variable_declarator
    name: (identifier) @variable.name
  )
) @variable

; var declarations
(variable_declaration
  (variable_declarator
    name: (identifier) @variable.name
  )
) @var_declaration

; -----------------------------------------------------------------------------
; MODULE/NAMESPACE (TypeScript)
; -----------------------------------------------------------------------------

; Module/namespace declaration
(module
  name: (identifier) @namespace.name
) @namespace

(module
  name: (string) @module.name
) @ambient_module

; -----------------------------------------------------------------------------
; IMPORTS
; -----------------------------------------------------------------------------

; Import declaration
(import_statement
  source: (string) @import.source
) @import

; Named imports
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.name
        alias: (identifier)? @import.alias
      )
    )
  )
) @named_import

; Default import
(import_statement
  (import_clause
    (identifier) @import.default
  )
) @default_import

; Namespace import
(import_statement
  (import_clause
    (namespace_import
      (identifier) @import.namespace
    )
  )
) @namespace_import

; Dynamic import
(call_expression
  function: (import)
  arguments: (arguments
    (string) @import.dynamic
  )
) @dynamic_import

; -----------------------------------------------------------------------------
; EXPORTS
; -----------------------------------------------------------------------------

; Export declaration (export function/class/etc)
(export_statement
  declaration: (_) @export.declaration
) @export_declaration

; Named exports
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @export.name
      alias: (identifier)? @export.alias
    )
  )
) @named_export

; Default export
(export_statement
  "default" @export.default
  value: (_) @export.value
) @default_export

; Re-export from module
(export_statement
  source: (string) @reexport.source
) @reexport

; Export all
(export_statement
  (export_clause "*") @export.all
  source: (string) @export.source
) @export_all

; -----------------------------------------------------------------------------
; COMMENTS (for doc extraction)
; -----------------------------------------------------------------------------

; JSDoc comments
(comment) @comment

; -----------------------------------------------------------------------------
; DECORATORS (TypeScript)
; -----------------------------------------------------------------------------

; Class decorator
(decorator
  (call_expression
    function: (identifier) @decorator.name
  )
) @decorator

(decorator
  (identifier) @decorator.name
) @simple_decorator
