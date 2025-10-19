# Publishing Guide

## Pre-publish Checklist

### 1. Build and Test

```bash
# Clean previous builds
rm -rf dist/

# Build the package
bun run build

# Verify types and linting
bun typecheck
bun lint

# Test the build (optional - create a test project)
npm pack
# This creates a .tgz file you can test locally
```

### 2. Version Management

Update version in `package.json`:

```json
{
  "version": "0.1.0" // Follow semver: major.minor.patch
}
```

**Semver Guidelines:**

- **Patch** (0.1.X): Bug fixes, documentation updates
- **Minor** (0.X.0): New features, backwards compatible
- **Major** (X.0.0): Breaking changes

### 3. Verify Package Contents

```bash
# Dry run to see what will be published
npm publish --dry-run

# Check the files that will be included
npm pack --dry-run
```

Should include:

- ✅ `dist/` - Compiled JavaScript + type definitions
- ✅ `docs/` - Documentation
- ✅ `examples/` - Example files
- ✅ `README.md` - Package documentation
- ✅ `LICENSE` - MIT license

Should NOT include:

- ❌ `src/*.ts` source files (only .d.ts)
- ❌ `node_modules/`
- ❌ Development configs

## Publishing to npm

### First Time Setup

```bash
# Login to npm (one time)
npm login
# Enter your npm credentials
```

### Publish

```bash
# Make sure you're on main/master
git checkout main
git pull

# Ensure everything is committed
git status

# Build
bun run build

# Publish to npm with public access
npm publish --access public

# Or if you want to test first, use a tag
npm publish --tag beta --access public
```

### After Publishing

```bash
# Tag the release in git
git tag v0.1.0
git push origin v0.1.0

# Verify on npm
npm view @falai/agent
```

## Post-Publish

1. **Update GitHub Release**

   - Go to https://github.com/falai-dev/agent/releases
   - Create a new release for the tag
   - Add release notes

2. **Verify Installation**

   ```bash
   # In a new project
   npm install @falai/agent
   # or
   bun add @falai/agent
   ```

3. **Test the Published Package**

   ```bash
   # Create test project
   mkdir test-agent && cd test-agent
   bun init -y
   bun add @falai/agent

   # Try importing
   echo 'import { Agent } from "@falai/agent"; console.log(Agent);' > test.ts
   bun run test.ts
   ```

## Troubleshooting

### "You do not have permission to publish"

- Make sure you're logged in: `npm whoami`
- Verify you have access to the `@falai` scope
- Contact scope owner if needed

### "Package already exists"

- You can't republish the same version
- Bump version in `package.json` and try again

### "Missing required files"

- Check `package.json` `files` field
- Ensure `dist/` exists after build
- Run `npm pack --dry-run` to preview

### Types not working

- Verify `types` field in `package.json`
- Ensure `.d.ts` files are in `dist/`
- Check `tsconfig.json` has `"declaration": true`

## Version History

- **0.1.0** - Initial release
  - Core agent framework
  - Route DSL
  - Gemini provider
  - Full TypeScript support
  - Declarative configuration

## Useful Commands

```bash
# Check what version is published
npm view @falai/agent version

# See all published versions
npm view @falai/agent versions

# Unpublish a version (within 24 hours, use carefully!)
npm unpublish @falai/agent@0.1.0

# Deprecate a version (preferred over unpublish)
npm deprecate @falai/agent@0.1.0 "This version has been deprecated. Please upgrade to 0.2.0"
```

---

**Made with ❤️ for the community**
