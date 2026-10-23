proxy_pass http://127.0.0.1:8081;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
# overwrite, never append: the app must not believe a client-supplied X-Forwarded-For
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-Host $host;
proxy_connect_timeout 10s;
proxy_read_timeout 60s;
