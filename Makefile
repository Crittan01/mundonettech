PNPM ?= pnpm

.PHONY: install dev build check test test-unit test-integration test-rls test-e2e test-owasp test-lighthouse test-k6 lint format format-check typecheck guards clean-tmp db-start db-stop db-status db-migrate db-validate db-verify release-verify audit-dependencies

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

test-owasp:
	$(PNPM) test:owasp

test-lighthouse:
	$(PNPM) test:lighthouse

test-k6:
	$(PNPM) test:k6

release-verify:
	$(PNPM) release:verify

audit-dependencies:
	$(PNPM) audit:dependencies

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

db-verify:
	$(PNPM) db:verify

clean-tmp:
	rm -rf -- tmp
