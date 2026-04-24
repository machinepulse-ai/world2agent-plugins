#!/usr/bin/env node
/**
 * World2Agent Channel for Claude Code
 *
 * This is the unified entry point for all World2Agent sensors in Claude Code.
 * It dynamically loads sensors based on user configuration and runs them
 * with a shared MCP connection to Claude Code.
 *
 * Features:
 * - Detects sensors needing configuration (have SETUP.md but no handler skill)
 * - Waits for user confirmation before starting sensors
 * - Exposes start_sensors tool for Claude to call after setup
 * - Exposes reload_sensors tool to add/remove/update sensors mid-session
 *   without restarting Claude Code
 */
export {};
