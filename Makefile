# SponsorBlock - build and install helpers.
#
#   make check   syntax-check main.js and lib/*.js, validate Info.json
#   make test    run the logic unit tests
#   make build   stage dist/SponsorBlock.iinaplugin/ and pack dist/SponsorBlock.iinaplgz
#   make link    symlink this folder into IINA's plugin folder as *.iinaplugin-dev
#   make unlink  remove that symlink
#   make clean   remove dist/
#
# Installing:
#   * make link, then enable "SponsorBlock" in IINA > Settings > Plugins.
#   * or make build and use IINA > Settings > Plugins > Install Local Package...
#     with dist/SponsorBlock.iinaplgz.

PLUGIN_NAME := SponsorBlock
DIST_DIR    := dist
BUNDLE      := $(DIST_DIR)/$(PLUGIN_NAME).iinaplugin
ARCHIVE     := $(DIST_DIR)/$(PLUGIN_NAME).iinaplgz

PLUGIN_DIR  := $(HOME)/Library/Application Support/com.colliderli.iina/plugins
LINK_NAME   := iina-sponsorblock.iinaplugin-dev

PACKAGE_FILES := Info.json main.js lib ui README.md LICENSE

.PHONY: all build check test link unlink clean

all: build

build:
	@rm -rf "$(BUNDLE)" "$(ARCHIVE)"
	@mkdir -p "$(BUNDLE)"
	@for entry in $(PACKAGE_FILES); do \
		if [ -e "$$entry" ]; then cp -R "$$entry" "$(BUNDLE)/"; \
		else echo "warning: $$entry is missing, skipping"; fi; \
	done
	@cd "$(BUNDLE)" && zip -r -X -q -y "../$(PLUGIN_NAME).iinaplgz" . -x '.*'
	@echo "built $(BUNDLE) and $(ARCHIVE)"

check:
	@node --check main.js
	@node --check lib/sponsorblock.js
	@node -e 'const j=require("./Info.json"); for (const k of ["name","version","identifier","entry"]) if (!j[k]) throw new Error("Info.json is missing "+k);'
	@echo "check ok"

test: check
	@node test/logic.test.js

link:
	@ln -sfn "$(CURDIR)" "$(PLUGIN_DIR)/$(LINK_NAME)"
	@echo "linked $(PLUGIN_DIR)/$(LINK_NAME) -> $(CURDIR)"

unlink:
	@rm -f "$(PLUGIN_DIR)/$(LINK_NAME)"
	@echo "unlinked"

clean:
	@rm -rf "$(DIST_DIR)"
