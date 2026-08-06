# Local dev shortcuts. Windows users can run the pnpm commands directly.
.PHONY: install check format db

install:
	pnpm install

check:
	pnpm check

format:
	pnpm format

db:
	@echo "Postgres/Redis compose setup lands with issue #4; run: docker compose up -d db redis"
