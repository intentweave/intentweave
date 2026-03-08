# Intent: Build a Planpling-Based IAM System

## Context

We need an authorization system that implements the **planpling model** for fine-grained access control across our multi-tenant SaaS platform.

## Core Requirements

### 1. Role Hierarchy

- Support workspace-level, project-level, and resource-level roles
- Roles should inherit permissions from parent scopes
- Prevent circular inheritance

### 2. Permission Model

- Permissions defined as `(action, resource)` pairs
- Actions: `read`, `write`, `delete`, `admin`
- Resources: hierarchical paths (e.g., `/workspace/{id}/project/{id}`)

### 3. Key Roles to Implement

**Workspace Level:**

- `workspace:owner` - Full control over workspace and all projects
- `workspace:admin` - Manage members and settings
- `workspace:member` - Read access to workspace resources

**Project Level:**

- `project:maintainer` - Manage project settings and members
- `project:contributor` - Write access to project resources
- `project:viewer` - Read-only access

### 4. Delegation

- Workspace owners can delegate admin privileges
- Project maintainers can grant contributor/viewer roles
- Audit log for all role assignments

## Success Criteria

1. Clear role hierarchy with inheritance
2. Granular permissions per resource type
3. No permission escalation vulnerabilities
4. Auditability of all access decisions

## Example Scenarios

**Scenario 1**: Alice is a workspace owner

- Can manage all projects in workspace
- Can assign project maintainers
- Cannot be removed by project maintainers

**Scenario 2**: Bob is a project contributor

- Can write to project resources
- Cannot manage project members
- Cannot access other projects (unless explicitly granted)

**Scenario 3**: Carol is workspace admin

- Can manage workspace members
- Cannot delete workspace
- Can view all projects but not modify them
