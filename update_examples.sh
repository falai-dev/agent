#!/bin/bash

# Remove createMessageEvent and EventSource from imports
find examples -name "*.ts" -exec sed -i '' '/createMessageEvent/d' {} \;
find examples -name "*.ts" -exec sed -i '' '/EventSource/d' {} \;

# Convert createMessageEvent calls to JSON format
# This is complex, so let's do it file by file for the most common patterns
