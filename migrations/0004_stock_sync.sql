-- W2: stock-paused flag. Products CJ ran dry on are paused (inventory zeroed),
-- not "non-performing" - the cull must not archive them.
ALTER TABLE product_links ADD COLUMN stock_paused INTEGER NOT NULL DEFAULT 0;
