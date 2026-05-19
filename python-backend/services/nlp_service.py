"""
NLP Service — spaCy-based semantic parsing for multi-language support.
Provides: tokenization, POS tagging, dependency parsing, phrase extraction.
"""
import logging
import threading
from typing import TYPE_CHECKING

from schemas.nlp import ParsedResult, ParsedSentence, SyntacticToken, PhraseChunk

if TYPE_CHECKING:
    import spacy

logger = logging.getLogger(__name__)

# spaCy model name mapping
SPACY_MODELS = {
    "en": "en_core_web_sm",
    # "zh": "zh_core_web_sm",   # future sprint
    # "ja": "ja_core_news_sm",  # future sprint
    # "de": "de_core_web_sm",   # future sprint
}


class NLPService:
    """Singleton NLP service with lazy model loading and thread safety."""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def _init(self):
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            self._models: dict[str, 'spacy.Language'] = {}
            self._model_locks: dict[str, threading.Lock] = {}
            self._available_langs: set[str] = set()
            self._initialized = True

    def _get_or_create_lock(self, lang: str) -> threading.Lock:
        if lang not in self._model_locks:
            self._model_locks[lang] = threading.Lock()
        return self._model_locks[lang]

    def load_model(self, lang: str = "en") -> bool:
        """Load a spaCy model for the given language. Thread-safe."""
        self._init()
        if lang in self._models:
            return True

        lock = self._get_or_create_lock(lang)
        with lock:
            if lang in self._models:
                return True

            model_name = SPACY_MODELS.get(lang)
            if not model_name:
                logger.warning("No spaCy model configured for language '%s'", lang)
                return False

            try:
                import spacy
                nlp = spacy.load(model_name)
                self._models[lang] = nlp
                self._available_langs.add(lang)
                logger.info("Loaded spaCy model '%s' for '%s'", model_name, lang)
                return True
            except (ImportError, OSError) as e:
                logger.warning("Failed to load spaCy model '%s': %s", model_name, e)
                return False

    def is_available(self, lang: str = "en") -> bool:
        """Check if a spaCy model is available for the given language."""
        self._init()
        return lang in self._available_langs

    def parse(self, text: str, language: str = "en") -> ParsedResult:
        """
        Parse text with spaCy NLP pipeline.
        Returns ParsedResult with tokens, phrases, sentences.
        Falls back to empty result if model not available (non-blocking).
        """
        self._init()

        if not text or not text.strip():
            return ParsedResult(language=language)

        if not self.load_model(language):
            logger.debug("NLP model for '%s' not available, skip parsing", language)
            return ParsedResult(language=language)

        try:
            nlp = self._models[language]
            doc = nlp(text.strip())

            all_tokens: list[SyntacticToken] = []
            all_phrases: list[PhraseChunk] = []
            sentences: list[ParsedSentence] = []

            for sent in doc.sents:
                sent_tokens = []
                for token in sent:
                    tok = SyntacticToken(
                        text=token.text,
                        lemma=token.lemma_,
                        pos=token.pos_,
                        tag=token.tag_,
                        dep=token.dep_,
                        head_text=token.head.text,
                        is_stop=token.is_stop,
                    )
                    sent_tokens.append(tok)
                    all_tokens.append(tok)

                sent_phrases = []
                for np in sent.noun_chunks:
                    phrase = PhraseChunk(
                        text=np.text,
                        root=np.root.text,
                        label="NP",
                        start=np.start_char,
                        end=np.end_char,
                    )
                    sent_phrases.append(phrase)
                    all_phrases.append(phrase)

                sentences.append(ParsedSentence(
                    text=sent.text,
                    tokens=sent_tokens,
                    phrases=sent_phrases,
                ))

            return ParsedResult(
                language=language,
                sentences=sentences,
                tokens=all_tokens,
                phrases=all_phrases,
            )
        except Exception as e:
            logger.error("NLP parsing error: %s", e, exc_info=True)
            return ParsedResult(language=language)

    def get_available_languages(self) -> list[str]:
        """Return list of languages with loaded models."""
        self._init()
        return list(self._available_langs)


# Module-level singleton
nlp_service = NLPService()
