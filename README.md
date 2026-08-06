# Chrome Extensions

Reusable, configurable browser-extension templates for repetitive web workflows.

Every package uses neutral placeholders and must be configured for a site you are authorized to automate. Review the host permissions, selectors, routes, field identifiers, and example values before loading an extension. Test in a non-production environment first.

## Browser extensions

| Template | What it demonstrates | Source | Download |
|---|---|---|---|
| Bulk Checkbox Enabler — Basic | Page through records and enable configured options | [Source](extensions/bulk-checkbox-enabler-basic/) | [ZIP](downloads/bulk-checkbox-enabler-basic.zip) |
| Bulk Checkbox Enabler — Pro | Resume, change-only saves, and CSV export | [Source](extensions/bulk-checkbox-enabler-pro/) | [ZIP](downloads/bulk-checkbox-enabler-pro.zip) |
| Bulk Contact Field Updater | Replace contact values or fill the first empty slot | [Source](extensions/bulk-contact-field-updater/) | [ZIP](downloads/bulk-contact-field-updater.zip) |
| Bulk Contact Replacer | Replace one configured contact with another across records | [Source](extensions/bulk-contact-replacer/) | [ZIP](downloads/bulk-contact-replacer.zip) |
| Bulk Email Field Cleaner | Clear a configured email field and log results | [Source](extensions/bulk-email-field-cleaner/) | [ZIP](downloads/bulk-email-field-cleaner.zip) |
| Bulk Related Contact Cleaner | Clear a related-contact field and disable a paired option | [Source](extensions/bulk-related-contact-cleaner/) | [ZIP](downloads/bulk-related-contact-cleaner.zip) |

## Installation

1. Download and extract a ZIP, or clone the repository.
2. Read the template's README and configure its placeholder host, selectors, and values.
3. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
4. Select the configured extension folder.

These templates use Chrome Manifest V3 and plain JavaScript. Last updated: 2026-08-05.

## Safety and provenance

The templates are derived from reusable automation patterns and contain no intended production configuration or real sample data. They can modify webpage data, so inspect and test them before use. No license has been selected for this repository.
