PNPM ?= pnpm

.PHONY: install dev build check test test-unit test-integration test-rls test-e2e lint format format-check typecheck guards clean-tmp db-start db-stop db-status db-migrate db-validate db-verify

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

test-unit:
	$(PNPM) test:unit

test-integration:
	$(PNPM) test:integration

test-rls:
	$(PNPM) test:rls

test-e2e:
	$(PNPM) test:e2e

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

db-start:
	$(PNPM) db:start

db-stop:
	$(PNPM) db:stop

db-status:
	$(PNPM) db:status

db-migrate:
	$(PNPM) db:migrate

db-validate:
	$(PNPM) db:validate

db-verify: build
	$(PNPM) db:verify

clean-tmp:
	rm -rf -- tmp
