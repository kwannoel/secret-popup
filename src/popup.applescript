on run argv
	set dialogText to item 1 of argv
	set timeoutSeconds to (item 2 of argv) as integer
	tell me to activate
	set answer to display dialog dialogText default answer "" with hidden answer with title "Claude Code: secret requested" buttons {"Cancel", "Save to .env"} default button "Save to .env" cancel button "Cancel" with icon caution giving up after timeoutSeconds
	if gave up of answer then error "timed out" number -1712
	return text returned of answer
end run
