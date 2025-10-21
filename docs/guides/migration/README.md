# Migration Guides

This directory contains migration guides for major changes and updates to the `@falai/agent` framework.

## Available Migration Guides

### [ResponseModal Refactor Migration Guide](./response-modal-refactor.md)

**Latest Update** - Comprehensive guide for migrating to the new ResponseModal architecture.

**What's New:**
- 🚀 **Modern Streaming API**: Simple `agent.stream('message')` interface
- 🏗️ **Better Architecture**: Separated response logic from Agent class
- 🔄 **Full Backward Compatibility**: All existing code continues to work
- ⚡ **Performance Improvements**: Unified response logic and optimizations

**Key Benefits:**
- Automatic session management with `stream()` API
- Simplified streaming interface compared to `respondStream()`
- Better error handling with `ResponseGenerationError`
- Improved maintainability and testability

**Migration Status:**
- ✅ **Backward Compatible**: No breaking changes
- ✅ **Gradual Migration**: Adopt new APIs at your own pace
- ✅ **Production Ready**: New APIs are fully tested and stable

---

## Migration Philosophy

Our migration approach prioritizes:

1. **🔄 Backward Compatibility**: Existing code continues to work without changes
2. **📈 Gradual Adoption**: New features can be adopted incrementally
3. **📚 Clear Documentation**: Comprehensive guides with examples
4. **🛠️ Developer Experience**: Improved APIs that are easier to use
5. **⚡ Performance**: Better performance without breaking existing functionality

## Getting Help

- **📖 Documentation**: Each migration guide includes detailed examples and comparisons
- **💡 Examples**: Check the [examples directory](../../../examples/) for updated code samples
- **🐛 Issues**: Report migration issues on [GitHub Issues](https://github.com/falai-dev/agent/issues)
- **💬 Discussions**: Ask questions in [GitHub Discussions](https://github.com/falai-dev/agent/discussions)

## Best Practices

### Before Migrating

1. **Read the migration guide** thoroughly
2. **Test in development** before applying to production
3. **Review examples** to understand new patterns
4. **Check for breaking changes** (though we avoid them when possible)

### During Migration

1. **Migrate gradually** - don't change everything at once
2. **Keep existing code working** while adopting new APIs
3. **Test thoroughly** after each migration step
4. **Monitor performance** to ensure improvements

### After Migration

1. **Update documentation** to reflect new patterns
2. **Train team members** on new APIs and best practices
3. **Monitor for issues** and report any problems
4. **Share feedback** to help improve future migrations

---

**Stay Updated**: Watch the repository for new migration guides and updates.