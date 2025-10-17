# Contributing to @falai/agent

First off, thank you for considering contributing to @falai/agent! 🎉

It's people like you that make @falai/agent such a great tool for building AI agents.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Style Guidelines](#style-guidelines)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)

---

## Code of Conduct

This project and everyone participating in it is governed by our commitment to fostering an open and welcoming environment. We pledge to make participation in our project a harassment-free experience for everyone.

### Our Standards

**Positive behavior includes:**

- Using welcoming and inclusive language
- Being respectful of differing viewpoints
- Gracefully accepting constructive criticism
- Focusing on what is best for the community
- Showing empathy towards other community members

**Unacceptable behavior includes:**

- Harassment, trolling, or insulting/derogatory comments
- Public or private harassment
- Publishing others' private information without permission
- Other conduct which could reasonably be considered inappropriate

---

## How Can I Contribute?

### 🐛 Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates.

**When submitting a bug report, include:**

- A clear and descriptive title
- Steps to reproduce the behavior
- Expected vs actual behavior
- Code samples or test cases
- Your environment (Node/Bun version, OS, TypeScript version)
- Screenshots if applicable

**Template:**

```markdown
**Description**
A clear description of the bug.

**To Reproduce**

1. Create an agent with '...'
2. Call method '...'
3. See error

**Expected Behavior**
What you expected to happen.

**Actual Behavior**
What actually happened.

**Environment**

- Node/Bun version:
- TypeScript version:
- @falai/agent version:
- OS:

**Additional Context**
Any other relevant information.
```

### 💡 Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues.

**When suggesting an enhancement, include:**

- A clear and descriptive title
- The current behavior vs proposed behavior
- Why this enhancement would be useful
- Examples of how it would work
- Potential implementation approach (optional)

### 📝 Documentation Improvements

Documentation is crucial! Feel free to:

- Fix typos or unclear wording
- Add examples
- Improve API documentation
- Create tutorials or guides
- Translate documentation

### 🔨 Code Contributions

Want to add a feature or fix a bug? Great!

---

## Getting Started

### Prerequisites

- **Node.js 18+** or **Bun 1.0+**
- **Git**
- **TypeScript knowledge**
- Familiarity with AI/LLM concepts (helpful but not required)

### Fork & Clone

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/YOUR_USERNAME/falai.git
cd falai

# Add upstream remote
git remote add upstream https://github.com/falai-dev/agent.git
```

### Install Dependencies

```bash
# Using bun (recommended)
bun install

# Or using npm
npm install
```

### Set Up Development Environment

```bash
# Create .env file
echo "GEMINI_API_KEY=your_test_key_here" > .env

# Build the project
bun run build

# Run type checking
bun typecheck

# Run linting
bun lint
```

---

## Development Workflow

### 1. Create a Branch

```bash
# Update your main branch
git checkout main
git pull upstream main

# Create a feature branch
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-description
```

**Branch naming conventions:**

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation only
- `refactor/` - Code refactoring
- `test/` - Adding tests
- `chore/` - Maintenance tasks

### 2. Make Your Changes

#### Project Structure

```
src/
├── types/          # Type definitions
├── core/           # Core classes (Agent, Route, etc.)
├── providers/      # AI provider implementations
├── utils/          # Utility functions
├── constants/      # Constants
└── index.ts        # Public exports
```

#### Key Principles

- **DRY** - Don't Repeat Yourself
- **Modular** - Keep code organized and reusable
- **Type-Safe** - Use TypeScript properly
- **Tested** - Add tests for new features
- **Documented** - Update docs for public APIs

### 3. Write Tests

```bash
# Run tests (when implemented)
bun test

# Run tests in watch mode
bun test --watch
```

**Test Guidelines:**

- Unit tests for individual functions
- Integration tests for features
- Add tests before fixing bugs
- Aim for >80% coverage

### 4. Check Your Code

```bash
# Type checking
bun typecheck

# Linting
bun lint

# Fix linting issues automatically
bun lint:fix

# Build to ensure no errors
bun run build
```

### 5. Commit Your Changes

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
git add .
git commit -m "feat: add support for routes"
```

**Commit types:**

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

**Examples:**

```bash
git commit -m "feat: add retry logic to AI provider"
git commit -m "fix: resolve route reference memory leak"
git commit -m "docs: update API reference for Agent class"
git commit -m "refactor: simplify prompt builder logic"
```

### 6. Push and Create PR

```bash
# Push your branch
git push origin feature/your-feature-name

# Create a Pull Request on GitHub
```

---

## Style Guidelines

### TypeScript Style

```typescript
// ✅ Good
interface UserContext {
  userId: string;
  userName: string;
}

const agent = new Agent<UserContext>({
  name: "SupportBot",
  provider: provider,
});

// ❌ Bad
interface user_context {
  user_id: string;
  user_name: string;
}

const agent = new Agent<any>({
  name: "SupportBot",
  provider: provider,
});
```

### Code Style

- **Use TypeScript** - No `any` types unless absolutely necessary
- **camelCase** for variables and functions
- **PascalCase** for classes and interfaces
- **UPPER_SNAKE_CASE** for constants
- **Explicit return types** for public APIs
- **JSDoc comments** for public methods
- **No console.log** in production code (use proper logging)

### File Organization

```typescript
/**
 * Brief description of the file
 */

// Imports - group by: external, internal types, internal code
import { ExternalLib } from "external-lib";
import type { MyType } from "@types/mytype";
import { MyClass } from "@core/MyClass";

// Constants
const DEFAULT_VALUE = 10;

// Types (if not in types/)
interface LocalType {
  // ...
}

// Main code
export class MyClass {
  // ...
}
```

### Documentation Style

````typescript
/**
 * Creates a new agent with the specified configuration.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   name: "MyBot",
 *   provider: provider,
 * });
 * ```
 *
 * @param options - Configuration options for the agent
 * @returns A new Agent instance
 */
export class Agent<TContext = unknown> {
  constructor(options: AgentOptions<TContext>) {
    // ...
  }
}
````

---

## Commit Guidelines

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Example:**

```
feat(agent): add support for custom AI providers

- Implement AiProvider interface
- Add OpenAI provider example
- Update documentation

Closes #123
```

### Scopes

- `agent` - Agent core
- `route` - Route/Journey DSL
- `tools` - Tool system
- `types` - Type definitions
- `providers` - AI providers
- `docs` - Documentation
- `examples` - Example files

---

## Pull Request Process

### Before Submitting

- [ ] Code compiles without errors (`bun run build`)
- [ ] All tests pass (`bun test`)
- [ ] Linting passes (`bun lint`)
- [ ] Type checking passes (`bun typecheck`)
- [ ] Documentation updated (if needed)
- [ ] Examples added (if new feature)
- [ ] CHANGELOG updated (for significant changes)

### PR Template

```markdown
## Description

Brief description of changes.

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## How Has This Been Tested?

Describe the tests you ran.

## Checklist

- [ ] My code follows the style guidelines
- [ ] I have performed a self-review
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes

## Related Issues

Closes #(issue number)
```

### Review Process

1. **Automated Checks** - CI must pass
2. **Code Review** - At least one maintainer approval required
3. **Testing** - Reviewers may test your changes
4. **Discussion** - Address feedback and questions
5. **Merge** - Once approved, maintainers will merge

---

## Questions?

- 💬 Open a [Discussion](https://github.com/falai-dev/agent/discussions)
- 🐛 Report an [Issue](https://github.com/falai-dev/agent/issues)
- 📧 Email: (if you want to add your email)

---

## Recognition

Contributors will be:

- Listed in our README
- Mentioned in release notes
- Part of our growing community! 🎉

---

**Thank you for contributing to @falai/agent!**

Made with ❤️ for the community
