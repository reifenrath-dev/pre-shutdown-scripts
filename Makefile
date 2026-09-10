NAME=pre-shutdown-scripts

.PHONY: all pack install clean

all: dist/extension.js

node_modules/.package-lock.json: package.json
	bun install

dist/extension.js dist/prefs.js: node_modules/.package-lock.json *.ts
	bun run build

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas schemas

$(NAME).zip: dist/extension.js dist/prefs.js schemas/gschemas.compiled stylesheet.css
	@cp -r schemas dist/
	@cp metadata.json stylesheet.css dist/
	@(cd dist && zip ../$(NAME).zip -9r .)

pack: $(NAME).zip

install: $(NAME).zip
	gnome-extensions install --force $(NAME).zip

clean:
	@rm -rf dist node_modules $(NAME).zip
