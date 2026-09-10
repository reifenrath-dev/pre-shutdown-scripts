import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

interface ScriptConfig {
    name?: string;
    filePath: string;
    haltOnError: boolean;
}

interface ScriptRow {
    row: Adw.PreferencesRow;
    nameEntry: Gtk.Entry;
    filePathEntry: Gtk.Entry;
    haltSwitch: Gtk.Switch;
}

export default class ScriptsBeforeShutdownPreferences extends ExtensionPreferences {
    override async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('Scripts'),
            icon_name: 'applications-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Scripts to run before shutdown'),
            description: _('Each script will appear as a checkbox in the shutdown dialog'),
        });
        page.add(group);

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add new script'),
            valign: Gtk.Align.CENTER,
        });
        group.set_header_suffix(addButton);

        const rows: ScriptRow[] = [];

        const saveScripts = (): void => {
            const scripts: ScriptConfig[] = rows.map(row => ({
                name: row.nameEntry.text || _('Unnamed Script'),
                filePath: row.filePathEntry.text || '',
                haltOnError: row.haltSwitch.active,
            })).filter(s => s.filePath);

            settings.set_string('scripts-json', JSON.stringify(scripts));
        };

        const removeRow = (row: ScriptRow): void => {
            const index = rows.indexOf(row);
            if (index !== -1) {
                rows.splice(index, 1);
                group.remove(row.row);
                saveScripts();
            }
        };

        const addRow = (name: string = '', command: string = '', haltOnError: boolean = false): void => {
            const rowWidget = new Adw.PreferencesRow({
                activatable: false,
            });

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 12,
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 12,
                margin_end: 12,
            });

            const headerBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 12,
            });

            const nameEntry = new Gtk.Entry({
                placeholder_text: _('Display Name'),
                hexpand: true,
                text: name || '',
            });

            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove this script'),
                valign: Gtk.Align.CENTER,
            });
            removeButton.add_css_class('destructive-action');

            headerBox.append(nameEntry);
            headerBox.append(removeButton);
            box.append(headerBox);

            const commandEntry = new Gtk.Entry({
                placeholder_text: _('Command or script path (e.g. /home/user/backup.sh)'),
                hexpand: true,
                text: command || '',
            });
            box.append(commandEntry);

            const haltRow = new Adw.ActionRow({
                title: _('Halt shutdown on error'),
                subtitle: _('Stop the shutdown process if this script fails'),
            });
            box.append(haltRow);

            const haltSwitch = new Gtk.Switch({
                active: haltOnError || false,
                valign: Gtk.Align.CENTER,
            });

            haltRow.add_suffix(haltSwitch);
            haltRow.set_activatable_widget(haltSwitch);

            rowWidget.set_child(box);

            removeButton.connect('clicked', () => removeRow({ row: rowWidget, nameEntry, filePathEntry: commandEntry, haltSwitch }));
            nameEntry.connect('changed', saveScripts);
            commandEntry.connect('changed', saveScripts);
            haltSwitch.connect('notify::active', saveScripts);

            group.add(rowWidget);
            rows.push({ row: rowWidget, nameEntry, filePathEntry: commandEntry, haltSwitch });
        };

        addButton.connect('clicked', () => addRow());

        try {
            const scripts: ScriptConfig[] = JSON.parse(settings.get_string('scripts-json') || '[]');
            scripts.forEach(s => addRow(s.name, s.filePath, s.haltOnError));
        } catch (e) {
            console.error('Failed to parse scripts JSON:', e);
        }
    }
}
