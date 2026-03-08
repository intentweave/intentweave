# Specification: Planpling IAM System

## Architecture Overview

The system implements a **hierarchical role-based access control (RBAC)** model with planpling-style inheritance and delegation.

## Domain Model

### Entities

#### Role

Represents a named collection of permissions at a specific scope.

**Properties:**

- `id` (string, UUID): Unique identifier
- `name` (string): Human-readable name (e.g., "workspace:owner")
- `scope` (enum): `workspace` | `project` | `resource`
- `inheritsFrom` (string[], role IDs): Parent roles for permission inheritance
- `permissions` (Permission[]): Granted permissions

**Constraints:**

- Name must follow pattern: `{scope}:{role-name}`
- Cannot inherit from roles at lower scope levels
- No circular inheritance chains

#### Permission

Represents an allowed action on a resource type.

**Properties:**

- `action` (enum): `read` | `write` | `delete` | `admin`
- `resourceType` (string): Type of resource (e.g., "project", "document")
- `resourcePattern` (string): Path pattern (e.g., "/workspace/_/project/_")

**Constraints:**

- Action must be specific (no wildcards)
- Resource patterns must be valid path expressions

#### Assignment

Links a user/group to a role within a specific context.

**Properties:**

- `userId` (string): User identifier
- `roleId` (string): Role identifier
- `contextId` (string): Workspace/project/resource ID
- `assignedBy` (string): User who made the assignment
- `assignedAt` (timestamp): When assignment was made

## Behavior Specifications

### Role Inheritance

**Rule**: Child roles inherit all permissions from parent roles.

**Algorithm**:

```
function getEffectivePermissions(role):
  permissions = role.permissions.copy()
  for parentRole in role.inheritsFrom:
    permissions.union(getEffectivePermissions(parentRole))
  return permissions
```

**Example**:

- `workspace:member` inherits from `project:viewer`
- If user has `workspace:member`, they automatically have `project:viewer` permissions

### Permission Evaluation

**Rule**: User has permission if ANY of their roles grants it.

**Algorithm**:

```
function hasPermission(user, action, resource):
  assignments = getAssignments(user, resource.context)
  for assignment in assignments:
    effectivePerms = getEffectivePermissions(assignment.role)
    if effectivePerms.allows(action, resource):
      return true
  return false
```

### Delegation Rules

**Rule**: Users can only delegate roles they have `admin` permission for.

**Constraints**:

- `workspace:owner` can delegate any workspace-level role
- `workspace:admin` can delegate `workspace:member` but not `workspace:owner`
- `project:maintainer` can delegate `project:contributor` and `project:viewer`

## API Contract

### Check Permission

```
POST /api/iam/check
Body: {
  userId: string,
  action: 'read' | 'write' | 'delete' | 'admin',
  resourceId: string
}
Response: {
  allowed: boolean,
  reason: string, // which role granted permission
  effectivePermissions: Permission[]
}
```

### Assign Role

```
POST /api/iam/assign
Body: {
  userId: string,
  roleId: string,
  contextId: string
}
Response: {
  assignmentId: string,
  effectivePermissions: Permission[]
}
```

### List User Roles

```
GET /api/iam/users/{userId}/roles
Response: {
  assignments: Assignment[],
  effectiveRoles: Role[]
}
```

## Implementation Requirements

### Database Schema

**roles** table:

- id (PK)
- name (unique)
- scope (enum)
- created_at
- updated_at

**permissions** table:

- id (PK)
- role_id (FK)
- action (enum)
- resource_type
- resource_pattern

**role_inheritance** table:

- parent_role_id (FK)
- child_role_id (FK)
- PRIMARY KEY (parent_role_id, child_role_id)

**role_assignments** table:

- id (PK)
- user_id
- role_id (FK)
- context_id
- assigned_by
- assigned_at

### Validation Rules

1. **No Circular Inheritance**: Detect cycles in `role_inheritance` graph
2. **Scope Consistency**: Child roles cannot inherit from higher-scope parents
3. **Permission Specificity**: No wildcard actions (must be explicit)
4. **Assignment Authorization**: Verify assigner has `admin` permission
5. **Context Validity**: Ensure `contextId` exists and matches role scope

## Security Considerations

### Privilege Escalation Prevention

- Users cannot assign roles they don't have
- Cannot modify own role assignments
- Audit all role changes

### Performance Optimization

- Cache effective permissions per user/context
- Invalidate cache on role/assignment changes
- Use graph database for inheritance traversal (optional)

## Testing Requirements

### Unit Tests

- Role inheritance calculation
- Permission evaluation logic
- Delegation authorization checks

### Integration Tests

- Full permission check flow
- Role assignment workflow
- Circular inheritance detection

### Example Test Cases

**Test 1**: Workspace owner can assign project maintainer

```
Given: Alice has workspace:owner role
When: Alice assigns project:maintainer to Bob
Then: Assignment succeeds
And: Bob gains project:maintainer permissions
```

**Test 2**: Project contributor cannot assign roles

```
Given: Bob has project:contributor role
When: Bob attempts to assign project:viewer to Carol
Then: Assignment fails (403 Forbidden)
```

**Test 3**: Circular inheritance is prevented

```
Given: Role A inherits from B, B inherits from C
When: Attempting to add inheritance C -> A
Then: Operation fails with validation error
```
