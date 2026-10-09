import os, json, trankit, torch
from transformers import XLMRobertaTokenizer
from .constants import WORKING_DIR
from .tokenizer_cache import load_tokenizer


class Config:
    def __init__(self, args_fpath):
        if os.path.exists(args_fpath):
            with open(args_fpath) as f:
                passed_args = json.load(f)
        else:
            passed_args = {
                'selection': 'mnlp',
                'target_embedding': 'nreimers/mMiniLMv2-L12-H384-distilled-from-XLMR-Large',
                'proxy_embedding': 'nreimers/mMiniLMv2-L6-H384-distilled-from-XLMR-Large'
            }
        # print('passed args: {}'.format(passed_args))
        self.cache_dir = os.path.join(WORKING_DIR, 'resource')
        self.target_embedding_name = passed_args['target_embedding']
        self.proxy_embedding_name = passed_args['proxy_embedding']

        self.trankit_tokenizer = trankit.Pipeline('english', gpu=torch.cuda.is_available(), cache_dir=os.path.join(WORKING_DIR, 'cache/trankit'))
        self.proxy_tokenizer = load_tokenizer(XLMRobertaTokenizer, self.proxy_embedding_name, self.cache_dir)
        self.target_tokenizer = load_tokenizer(XLMRobertaTokenizer, self.target_embedding_name, self.cache_dir)
        self.max_sent_length = 200

        self.target_reduction_factor = 4
        self.proxy_reduction_factor = 2
        self.embedding_dropout = 0.4
        self.hidden_num = 200

        self.adapter_learning_rate = 2e-4
        self.adapter_weight_decay = 2e-4
        self.learning_rate = 1e-3
        self.weight_decay = 1e-3

        self.batch_size = 16
        self.proxy_max_epoch = 20
        self.target_max_epoch = 40
        self.seed = 3456
        self.accumulate_step = 1
        self.grad_clipping = 4.5

        self.distill = True
        self.selection = passed_args['selection']
        assert self.selection in ['random', 'bertkm', 'badge', 'mnlp']

        self.num_examples_per_iter = 50

        self.vocabs = {}

        if torch.cuda.is_available():
            self.use_gpu = True
        else:
            self.use_gpu = False


config = Config(os.path.join(WORKING_DIR, 'passed_args.json'))
