/*
 * 404AD neutered script.
 *
 * Served in place of a blocked script when a filter uses $redirect=noopjs.
 * A page that expects the script to exist gets a 200 and an empty program
 * instead of a failed request, so its own error handling never fires.
 */
