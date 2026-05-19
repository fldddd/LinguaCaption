from pydantic import BaseModel


class SyntacticToken(BaseModel):
    text: str
    lemma: str = ""
    pos: str = ""           # 粗粒度词性 (NOUN/VERB/ADJ...)
    tag: str = ""           # 细粒度词性标签 (NN/VBD/JJ...)
    dep: str = ""           # 句法依存关系 (nsubj/dobj/amod...)
    head_text: str = ""     # 中心词
    is_stop: bool = False   # 是否停用词


class PhraseChunk(BaseModel):
    text: str
    root: str = ""          # 核心词
    label: str = ""         # 词组类型 (NP/VP/ADJP/ADVP...)
    start: int = 0          # 起始字符位置
    end: int = 0            # 结束字符位置


class ParsedSentence(BaseModel):
    text: str
    tokens: list[SyntacticToken] = []
    phrases: list[PhraseChunk] = []


class ParsedResult(BaseModel):
    language: str = "en"
    sentences: list[ParsedSentence] = []
    tokens: list[SyntacticToken] = []
    phrases: list[PhraseChunk] = []
