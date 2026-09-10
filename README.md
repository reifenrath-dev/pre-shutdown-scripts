# Pre-Shutdown Scripts
This is a GNOME extension, that will add options for scripts to run before shutdown. You can configure what scripts to run from the extension settings menu and if a failure should halt the shutdown.

## Selection
[<img src="./docs/selection.png" alt="Power Off dialog with a list of two checkboxes for selecting scripts to run before shutdown: 'Check Backup Disk Mounted' and 'Backup System', both checked. Cancel and Power Off buttons appear at the bottom.">]

## Execution
[<img src="./docs/execution.png" alt="Running Scripts dialog showing execution status. 'Check Backup Disk Mounted' completed successfully (green checkmark) with expanded output visible. 'Backup System' failed (red X) with exit code 1. Status reads 'All scripts completed. Shutting down...' with a Cancel button at the bottom.">]

## Settings
[<img src="./docs/settings.png" alt="Pre-Shutdown Scripts preferences window. Two scripts are configured: 'Check Backup Disk Mounted' pointing to ~/check.sh with 'Halt shutdown on error' enabled, and 'Backup System' pointing to ~/backup-system.sh with 'Halt shutdown on error' disabled. A plus button for adding new scripts is visible in the top-right corner.">]
