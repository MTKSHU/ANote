-- Public installations already use ANote by default. Preserve configured names.
ALTER TABLE platform_settings ALTER COLUMN site_name SET DEFAULT 'ANote';
