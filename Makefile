.PHONY: help install sync build clean lint format typecheck test test-cov conformance

help:
	@echo "dagstack-config-typescript — TypeScript binding for dagstack/config-spec"
	@echo ""
	@echo "Targets:"
	@echo "  install       npm install"
	@echo "  sync          git submodule update + npm install"
	@echo "  build         tsc -b"
	@echo "  clean         rm dist / coverage / .tsbuildinfo"
	@echo "  lint          eslint ."
	@echo "  format        prettier --write ."
	@echo "  typecheck     tsc --noEmit"
	@echo "  test          vitest run"
	@echo "  test-cov      vitest run --coverage"
	@echo "  conformance   vitest run tests/conformance.test.ts (требует spec/ submodule)"

install:
	npm install

sync:
	git submodule update --init --recursive
	npm install

build:
	npm run build

clean:
	npm run clean

lint:
	npm run lint

format:
	npm run format

typecheck:
	npm run typecheck

test:
	npm run test

test-cov:
	npm run test:cov

conformance:
	npm run conformance
