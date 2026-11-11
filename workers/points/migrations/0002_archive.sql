-- Архив сессий: заголовок, модель и токены сессии — в строке точки; урезанная копия последних обменов (last) снята.
ALTER TABLE points ADD COLUMN title TEXT;
ALTER TABLE points ADD COLUMN model TEXT;
ALTER TABLE points ADD COLUMN tok_in INTEGER;
ALTER TABLE points ADD COLUMN tok_out INTEGER;
ALTER TABLE points DROP COLUMN last;
