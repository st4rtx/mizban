.PHONY: up down dev test seed reset logs
# One command: full stack (db + app) with demo data at http://localhost:8081
up:
	@test -f .env || (cp .env.example .env && sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$$(openssl rand -hex 32)/" .env && echo "created .env")
	docker compose up --build -d
	@echo "Open http://localhost:$${APP_PORT:-8081}  (demo accounts are listed on the login page)"
down:
	docker compose down
logs:
	docker compose logs -f app
# Developer loop: db in docker, API + Vite on the host
dev:
	docker compose up -d db
	cd server && npm run migrate && npm run seed && (npm run dev & cd ../web && npm run dev)
test:
	cd server && npm test
reset:
	cd server && npm run seed -- --reset
