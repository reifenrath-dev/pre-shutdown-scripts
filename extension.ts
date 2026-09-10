import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { Extension, InjectionManager, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as CheckBox from 'resource:///org/gnome/shell/ui/checkBox.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

class ScriptExpanderRow {
    container: St.BoxLayout;
    header: St.BoxLayout;
    arrow: St.Icon;
    title: St.Label;
    statusIcon: St.Bin;
    contentContainer: St.BoxLayout;
    outputScroll: St.ScrollView;
    outputBox: St.BoxLayout;
    outputLabel: St.Label;
    expanded: boolean;
    outputBuffer: string[];

    private _updateTimeout: number = 0;

    constructor(displayName: string) {
        this.expanded = false;
        this.outputBuffer = [];

        this.container = new St.BoxLayout({
            style_class: 'scripts-expander-row',
            vertical: true,
            x_expand: true,
        });

        this.header = new St.BoxLayout({
            style_class: 'scripts-expander-row-header',
            x_expand: true,
        });

        this.statusIcon = new St.Bin({
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
        });
        this.statusIcon.set_size(16, 16);

        this.title = new St.Label({
            text: displayName,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            margin_left: 8,
        });

        this.arrow = new St.Icon({
            icon_name: 'pan-end-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });

        this.header.add_child(this.statusIcon);
        this.header.add_child(this.title);
        this.header.add_child(this.arrow);

        this.outputLabel = new St.Label({
            style_class: 'scripts-output-text',
            x_expand: true,
        });
        this.outputLabel.clutter_text.line_wrap = false;
        this.outputLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this.outputBox = new St.BoxLayout({
            style_class: 'scripts-output-box',
            vertical: true,
            x_expand: true,
        });
        this.outputBox.add_child(this.outputLabel);

        this.outputScroll = new St.ScrollView({
            style_class: 'scripts-output-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this.outputScroll.set_child(this.outputBox);

        this.contentContainer = new St.BoxLayout({
            style_class: 'scripts-expander-row-content',
            vertical: true,
            x_expand: true,
            visible: false,
            y_expand: false,
        });
        this.contentContainer.add_child(this.outputScroll);

        this.container.add_child(this.header);
        this.container.add_child(this.contentContainer);
    }

    toggle(): void {
        this.expanded = !this.expanded;
        this.contentContainer.visible = this.expanded;
        this.arrow.icon_name = this.expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
    }

    collapse(): void {
        if (this.expanded) {
            this.expanded = false;
            this.contentContainer.visible = false;
            this.arrow.icon_name = 'pan-end-symbolic';
        }
    }

    setStatusIcon(icon: St.Icon | null): void {
        this.statusIcon.set_child(icon);
    }

    appendOutput(line: string): void {
        this.outputBuffer.push(line);
        if (this.outputBuffer.length > 500) {
            this.outputBuffer.shift();
        }

        if (this._updateTimeout) {
            GLib.source_remove(this._updateTimeout);
        }
        this._updateTimeout = GLib.timeout_add(GLib.PRIORITY_LOW, 16, () => {
            this._flushOutput();
            this._updateTimeout = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    private _flushOutput(): void {
        this.outputLabel.text = this.outputBuffer.join('\n');
        const vadj = this.outputScroll.vadjustment;
        vadj.value = vadj.upper - vadj.page_size;
    }

    cleanup(): void {
        if (this._updateTimeout) {
            GLib.source_remove(this._updateTimeout);
            this._updateTimeout = 0;
        }
    }
}

interface ScriptConfig {
    name?: string;
    filePath: string;
    haltOnError: boolean;
}

export default class ScriptsBeforeShutdownExtension extends Extension {
    private _settings: any = null;
    private _injectionManager: InjectionManager | null = null;
    private _systemActions: SystemActions.SystemActions | null = null;
    private _dialog: ModalDialog.ModalDialog | null = null;
    private _progressDialog: ModalDialog.ModalDialog | null = null;

    private _readingOutput: boolean = false;
    private _executionCancelled: boolean = false;
    private _halted: boolean = false;
    private _pendingScripts: ScriptConfig[] = [];
    private _scriptExpanders: ScriptExpanderRow[] = [];
    private _currentSpinner: St.Icon | null = null;
    private _spinnerTimeout: number = 0;
    private _spinnerAngle: number = 0;
    private _statusLabel: St.Label | null = null;

    private _subprocess: Gio.Subprocess | null = null;
    private _dataStream: Gio.DataInputStream | null = null;

    override enable(): void {
        this._settings = this.getSettings();
        this._injectionManager = new InjectionManager();
        this._systemActions = SystemActions.getDefault();

        this._injectionManager.overrideMethod(
            Object.getPrototypeOf(this._systemActions),
            'activatePowerOff',
            (originalMethod: (...args: any[]) => void) => {
                return (...args: any[]) => {
                    const scripts = this._getScripts();
                    if (scripts.length === 0) {
                        originalMethod.apply(this._systemActions, args);
                        return;
                    }
                    Main.panel.closeQuickSettings?.();
                    this._showSelectionDialog(scripts, () => {
                        originalMethod.apply(this._systemActions, args);
                    });
                };
            }
        );
    }

    override disable(): void {
        this._cancelExecution();
        this._cleanupSpinner();
        this._injectionManager?.clear();
        this._injectionManager = null;
        this._settings = null;
        this._systemActions = null;
        this._dialog = null;
        this._progressDialog = null;
    }

    private _getScripts(): ScriptConfig[] {
        try {
            const json = this._settings.get_string('scripts-json') || '[]';
            return JSON.parse(json) as ScriptConfig[];
        } catch (e) {
            console.error('Error parsing scripts:', e);
            return [];
        }
    }

    private _getDisplayName(script: ScriptConfig): string {
        if (script.name && script.name.trim()) {
            return script.name.trim();
        }

        const filePath = (script.filePath || '').trim();
        if (!filePath) {
            return _('Unnamed Script');
        }

        const firstToken = filePath.split(/\s+/)[0];
        const parts = firstToken!.split('/');
        return parts[parts.length - 1] || _('Unnamed Script');
    }

    private _showSelectionDialog(scripts: ScriptConfig[], proceedWithShutdown: () => void): void {
        if (this._dialog) return;

        this._dialog = new ModalDialog.ModalDialog({
            styleClass: 'scripts-before-shutdown-dialog',
            destroyOnClose: true,
        });

        const content = new Dialog.MessageDialogContent({
            title: _('Power Off'),
            description: _('Select scripts to run before shutting down:'),
        });
        this._dialog.contentLayout.add_child(content);

        const checkboxes: CheckBox.CheckBox[] = scripts.map((script) => {
            const displayName = this._getDisplayName(script);
            const checkbox = new CheckBox.CheckBox(displayName);
            checkbox.checked = true;
            this._dialog!.contentLayout.add_child(checkbox);
            return checkbox;
        });

        this._dialog.setButtons([
            {
                label: _('Cancel'),
                action: () => this._dialog?.close(),
                key: Clutter.KEY_Escape,
            },
            {
                label: _('Power Off'),
                action: () => {
                    const selectedScripts = scripts.filter((_, i) => checkboxes[i]!.checked);
                    this._dialog?.close();
                    this._dialog = null;
                    if (selectedScripts.length > 0) {
                        this._showProgressDialog(selectedScripts, proceedWithShutdown);
                    } else {
                        proceedWithShutdown();
                    }
                },
                default: true,
            },
        ]);

        this._dialog.connect('closed', () => {
            this._dialog = null;
        });

        this._dialog.open();
    }

    private _showProgressDialog(scripts: ScriptConfig[], proceedWithShutdown: () => void): void {
        if (this._progressDialog) return;

        this._readingOutput = false;
        this._executionCancelled = false;
        this._halted = false;
        this._pendingScripts = scripts.slice();
        this._scriptExpanders = [];

        this._progressDialog = new ModalDialog.ModalDialog({
            styleClass: 'scripts-progress-dialog',
            destroyOnClose: true,
        });

        const content = new Dialog.MessageDialogContent({
            title: _('Running Scripts'),
        });
        this._progressDialog.contentLayout.add_child(content);

        const listBox = new St.BoxLayout({
            style_class: 'scripts-list',
            vertical: true,
            x_expand: true,
            margin_top: 16,
        });

        // Track currently expanded index
        let currentExpandedIndex: number = -1;

        scripts.forEach((script, index) => {
            const displayName = this._getDisplayName(script);
            const expander = new ScriptExpanderRow(displayName);
            listBox.add_child(expander.container);
            this._scriptExpanders.push(expander);

            expander.header.set_reactive(true);
            expander.header.connect('button-press-event', () => {
                if (currentExpandedIndex >= 0 && currentExpandedIndex < this._scriptExpanders.length) {
                    this._scriptExpanders[currentExpandedIndex]!.collapse();
                }
                expander.toggle();
                currentExpandedIndex = expander.expanded ? index : -1;
                return Clutter.EVENT_STOP;
            });
        });

        this._progressDialog.contentLayout.add_child(listBox);

        this._statusLabel = new St.Label({
            text: _('Starting…'),
            style_class: 'scripts-status-label',
            x_expand: true,
            margin_top: 12,
        });
        this._progressDialog.contentLayout.add_child(this._statusLabel);

        this._progressDialog.setButtons([{
            label: _('Cancel'),
            action: () => {
                this._cancelExecution();
                this._progressDialog?.close();
            },
            key: Clutter.KEY_Escape,
        }]);

        this._progressDialog.connect('closed', () => {
            this._scriptExpanders.forEach(e => e.cleanup());
            this._cleanupSpinner();
            this._progressDialog = null;
        });

        this._progressDialog.open();

        this._spinnerAngle = 0;
        this._spinnerTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            if (this._currentSpinner) {
                this._spinnerAngle = (this._spinnerAngle + 10) % 360;
                this._currentSpinner.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, this._spinnerAngle);
            }
            return GLib.SOURCE_CONTINUE;
        });

        this._executeNextScript(proceedWithShutdown);
    }

    private _createSpinnerIcon(): St.Icon {
        const icon = new St.Icon({
            icon_name: 'process-working-symbolic',
            icon_size: 16,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        icon.set_pivot_point(0.5, 0.5);
        return icon;
    }

    private _setSuccessIcon(iconBin: St.Bin): void {
        this._currentSpinner = null;
        const icon = new St.Icon({
            icon_name: 'emblem-ok-symbolic',
            icon_size: 16,
            style_class: 'scripts-success-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        iconBin.set_child(icon);
    }

    private _setErrorIcon(iconBin: St.Bin): void {
        this._currentSpinner = null;
        const icon = new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_size: 16,
            style_class: 'scripts-error-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        iconBin.set_child(icon);
    }

    private _executeNextScript(proceedWithShutdown: () => void): void {
        if (this._executionCancelled) return;

        if (this._halted) {
            this._cleanupSpinner();
            if (this._statusLabel) {
                this._statusLabel.text = _('Shutdown halted due to script error');
                this._statusLabel.add_style_class_name('scripts-status-error');
            }

            if (this._progressDialog) {
                this._progressDialog.setButtons([{
                    label: _('Close'),
                    action: () => this._progressDialog?.close(),
                    key: Clutter.KEY_Escape,
                    default: true,
                }]);
            }
            return;
        }

        if (this._pendingScripts.length === 0) {
            this._cleanupSpinner();
            if (this._statusLabel) {
                this._statusLabel.text = _('All scripts completed. Shutting down…');
            }

            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                this._progressDialog?.close();
                proceedWithShutdown();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const script = this._pendingScripts.shift()!;
        const expanderIndex = this._scriptExpanders.length - this._pendingScripts.length - 1;
        const displayName = this._getDisplayName(script);

        if (this._statusLabel) {
            this._statusLabel.text = _('Running: %s').format(displayName);
        }

        if (expanderIndex >= 0 && expanderIndex < this._scriptExpanders.length) {
            const spinnerIcon = this._createSpinnerIcon();
            this._currentSpinner = spinnerIcon;
            this._scriptExpanders[expanderIndex]!.setStatusIcon(spinnerIcon);
        }

        this._runSubprocess(script, expanderIndex, proceedWithShutdown);
    }

    private _runSubprocess(script: ScriptConfig, expanderIndex: number, proceedWithShutdown: () => void): void {
        const filePath = script.filePath?.trim();
        if (!filePath) {
            const errorMsg = '  ✗ Error: Script filePath is empty or undefined';
            console.error(errorMsg, script);
            if (expanderIndex >= 0 && expanderIndex < this._scriptExpanders.length) {
                this._scriptExpanders[expanderIndex]!.appendOutput(errorMsg);
                this._setErrorIcon(this._scriptExpanders[expanderIndex]!.statusIcon);
            }
            if (script.haltOnError) this._halted = true;
            this._executeNextScript(proceedWithShutdown);
            return;
        }

        try {
            const escapedPath = filePath.replace(/'/g, "'\\''");
            this._subprocess = new Gio.Subprocess({
                argv: ['bash', '-c', `${escapedPath} 2>&1`],
                flags: Gio.SubprocessFlags.STDOUT_PIPE,
            });
            this._subprocess.init(null);

            const stdoutPipe = this._subprocess.get_stdout_pipe();
            if (stdoutPipe) {
                this._dataStream = new Gio.DataInputStream({ base_stream: stdoutPipe });
                this._readingOutput = true;
                this._readOutput(expanderIndex);
            }

            this._subprocess.wait_async(null, (subprocess: Gio.Subprocess | null, result: Gio.AsyncResult) => {
                if (!subprocess) return;
                try {
                    subprocess.wait_finish(result);
                } catch (e) {
                    console.error('Error in subprocess wait:', e);
                }

                if (this._executionCancelled || !this._subprocess) return;

                const success = subprocess.get_successful();

                if (success) {
                    if (expanderIndex >= 0 && expanderIndex < this._scriptExpanders.length) {
                        this._scriptExpanders[expanderIndex]!.appendOutput(_('  ✓ Completed'));
                        this._setSuccessIcon(this._scriptExpanders[expanderIndex]!.statusIcon);
                    }
                } else {
                    const exitCode = subprocess.get_exit_status();
                    if (expanderIndex >= 0 && expanderIndex < this._scriptExpanders.length) {
                        this._scriptExpanders[expanderIndex]!.appendOutput(
                            _('  ✗ Failed (exit code %d)').format(exitCode)
                        );
                        this._setErrorIcon(this._scriptExpanders[expanderIndex]!.statusIcon);
                    }

                    if (script.haltOnError) {
                        this._halted = true;
                    }
                    if (this._statusLabel) {
                        this._statusLabel.text = script.haltOnError
                            ? _('  ⛔ Shutdown halted as requested')
                            : _('Script failed. Continuing…');
                    }
                }

                this._dataStream = null;
                this._subprocess = null;
                this._executeNextScript(proceedWithShutdown);
            });
        } catch (e: any) {
            console.error('Error running subprocess:', e);
            if (expanderIndex >= 0 && expanderIndex < this._scriptExpanders.length) {
                this._scriptExpanders[expanderIndex]!.appendOutput(`  ✗ Error: ${e.message}`);
                this._setErrorIcon(this._scriptExpanders[expanderIndex]!.statusIcon);
            }

            if (script.haltOnError) {
                this._halted = true;
            }
            if (this._statusLabel) {
                this._statusLabel.text = script.haltOnError
                    ? _('  ⛔ Shutdown halted as requested')
                    : _('Script failed. Continuing…');
            }

            this._executeNextScript(proceedWithShutdown);
        }
    }

    private _readOutput(expanderIndex: number): void {
        if (!this._dataStream || !this._readingOutput) return;

        this._dataStream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            null,
            (source: Gio.DataInputStream | null, result: Gio.AsyncResult) => {
                if (!this._readingOutput || !source) return;

                try {
                    const [bytes] = source.read_line_finish(result);
                    if (bytes !== null) {
                        const line = new TextDecoder().decode(bytes);
                        if (expanderIndex >= 0 && expanderIndex < this._scriptExpanders.length) {
                            this._scriptExpanders[expanderIndex]!.appendOutput(line);
                        }
                        if (this._readingOutput) {
                            this._readOutput(expanderIndex);
                        }
                    }
                } catch (e) {
                    this._readingOutput = false;
                }
            }
        );
    }

    private _cancelExecution(): void {
        this._executionCancelled = true;
        this._readingOutput = false;

        if (this._subprocess) {
            try {
                this._subprocess.force_exit();
            } catch (e) {
                console.error('Error forcing subprocess exit:', e);
            }
            this._subprocess = null;
        }
        this._cleanupSpinner();
    }

    private _cleanupSpinner(): void {
        this._currentSpinner = null;
        if (this._spinnerTimeout) {
            GLib.source_remove(this._spinnerTimeout);
            this._spinnerTimeout = 0;
        }
    }
}
