"""Prefer already downloaded tokenizer files so startup survives network outages."""
import os


def load_tokenizer(tokenizer_type, model_name, cache_root):
    options = {'cache_dir': os.path.join(cache_root, model_name), 'do_lower_case': False}
    try:
        return tokenizer_type.from_pretrained(model_name, local_files_only=True, **options)
    except (OSError, ValueError):
        print('Tokenizer cache unavailable; downloading required resources for {}.'.format(model_name), flush=True)
        return tokenizer_type.from_pretrained(model_name, local_files_only=False, **options)
