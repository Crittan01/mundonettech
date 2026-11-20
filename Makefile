PNPM ?= pnpm

.PHONY: install dev build check test lint format format-check typecheck guards clean-tmp

install:
	$(PNPM) install --frozen-lockfile

dev:
	$(PNPM) dev

build:
	$(PNPM) build

check:
	$(PNPM) check

test:
	$(PNPM) test

lint:
	$(PNPM) lint

format:
	$(PNPM) format

format-check:
	$(PNPM) format:check

typecheck:
	$(PNPM) typecheck

guards:
	$(PNPM) guards

clean-tmp:
	rm -rf -- tmp
