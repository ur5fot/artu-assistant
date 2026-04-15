FROM mcr.microsoft.com/presidio-analyzer:2.2.362

RUN pip install --no-cache-dir \
    https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.7.1/en_core_web_sm-3.7.1.tar.gz \
    https://github.com/explosion/spacy-models/releases/download/ru_core_news_sm-3.7.0/ru_core_news_sm-3.7.0.tar.gz \
    https://github.com/explosion/spacy-models/releases/download/uk_core_news_sm-3.7.0/uk_core_news_sm-3.7.0.tar.gz

COPY multilang.yaml /usr/bin/presidio-analyzer/presidio_analyzer/conf/default.yaml
