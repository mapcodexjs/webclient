var name = name || {};
var define = define || {};

// jquerystorage

(function(){
    var
        /* jStorage version */
        JSTORAGE_VERSION = "0.4.3",

        /* detect a dollar object or create one if not found */
        $ = window.jQuery || window.$ || (window.$ = {}),

        /* check for a JSON handling support */
        JSON = {
            parse    :
            window.JSON && (window.JSON.parse || window.JSON.decode) ||
            String.prototype.evalJSON && function(str){
                return String(str).evalJSON();
            } ||
            $.parseJSON ||
            $.evalJSON,
            stringify:
            Object.toJSON ||
            window.JSON && (window.JSON.stringify || window.JSON.encode) ||
            $.toJSON
        };

    // Break if no JSON support was found
    if(!JSON.parse || !JSON.stringify)
    {
        throw new Error("No JSON support found, include //cdnjs.cloudflare.com/ajax/libs/json2/20110223/json2.js to page");
    }

    var
        /* This is the object, that holds the cached values */
        _storage = {__jstorage_meta: {CRC32: {}}},

        /* Actual browser storage (localStorage or globalStorage['domain']) */
        _storage_service = {jStorage: "{}"},

        /* DOM element for older IE versions, holds userData behavior */
        _storage_elm = null,

        /* How much space does the storage take */
        _storage_size = 0,

        /* which backend is currently used */
        _backend = false,

        /* onchange observers */
        _observers = {},

        /* timeout to wait after onchange event */
        _observer_timeout = false,

        /* last update time */
        _observer_update = 0,

        /* pubsub observers */
        _pubsub_observers = {},

        /* skip published items older than current timestamp */
        _pubsub_last = +new Date(),

        /* Next check for TTL */
        _ttl_timeout,

        /**
         * XML encoding and decoding as XML nodes can't be JSON'ized
         * XML nodes are encoded and decoded if the node is the value to be saved
         * but not if it's as a property of another object
         * Eg. -
         *   $.jStorage.set("key", xmlNode);        // IS OK
         *   $.jStorage.set("key", {xml: xmlNode}); // NOT OK
         */
        _XMLService = {

            /**
             * Validates a XML node to be XML
             * based on jQuery.isXML function
             */
            isXML: function(elm){
                var documentElement = (elm? elm.ownerDocument || elm : 0).documentElement;
                return documentElement? documentElement.nodeName !== "HTML" : false;
            },

            /**
             * Encodes a XML node to string
             * based on http://www.mercurytide.co.uk/news/article/issues-when-working-ajax/
             */
            encode: function(xmlNode){
                if(!this.isXML(xmlNode))
                {
                    return false;
                }
                try
                { // Mozilla, Webkit, Opera
                    return new XMLSerializer().serializeToString(xmlNode);
                }
                catch(E1)
                {
                    try
                    {  // IE
                        return xmlNode.xml;
                    }
                    catch(E2)
                    {
                    }
                }
                return false;
            },

            /**
             * Decodes a XML node from string
             * loosely based on http://outwestmedia.com/jquery-plugins/xmldom/
             */
            decode: function(xmlString){
                var dom_parser = ("DOMParser" in window && (new DOMParser()).parseFromString) ||
                    (window.ActiveXObject && function(_xmlString){
                        var xml_doc = new ActiveXObject('Microsoft.XMLDOM');
                        xml_doc.async = 'false';
                        xml_doc.loadXML(_xmlString);
                        return xml_doc;
                    }),
                    resultXML;
                if(!dom_parser)
                {
                    return false;
                }
                resultXML = dom_parser.call("DOMParser" in window && (new DOMParser()) || window, xmlString, 'text/xml');
                return this.isXML(resultXML)? resultXML : false;
            }
        };

    ////////////////////////// PRIVATE METHODS ////////////////////////

    /**
     * Initialization function. Detects if the browser supports DOM Storage
     * or userData behavior and behaves accordingly.
     */
    function _init()
    {
        /* Check if browser supports localStorage */
        var localStorageReallyWorks = false;
        if("localStorage" in window)
        {
            try
            {
                window.localStorage.setItem('_tmptest', 'tmpval');
                localStorageReallyWorks = true;
                window.localStorage.removeItem('_tmptest');
            }
            catch(BogusQuotaExceededErrorOnIos5)
            {
                // Thanks be to iOS5 Private Browsing mode which throws
                // QUOTA_EXCEEDED_ERRROR DOM Exception 22.
            }
        }

        if(localStorageReallyWorks)
        {
            try
            {
                if(window.localStorage)
                {
                    _storage_service = window.localStorage;
                    _backend = "localStorage";
                    _observer_update = _storage_service.jStorage_update;
                }
            }
            catch(E3)
            {/* Firefox fails when touching localStorage and cookies are disabled */
            }
        }
        /* Check if browser supports globalStorage */
        else if("globalStorage" in window)
        {
            try
            {
                if(window.globalStorage)
                {
                    _storage_service = window.globalStorage[window.location.hostname];
                    _backend = "globalStorage";
                    _observer_update = _storage_service.jStorage_update;
                }
            }
            catch(E4)
            {/* Firefox fails when touching localStorage and cookies are disabled */
            }
        }
        /* Check if browser supports userData behavior */
        else
        {
            _storage_elm = document.createElement('link');
            if(_storage_elm.addBehavior)
            {

                /* Use a DOM element to act as userData storage */
                _storage_elm.style.behavior = 'url(#default#userData)';

                /* userData element needs to be inserted into the DOM! */
                document.getElementsByTagName('head')[0].appendChild(_storage_elm);

                try
                {
                    _storage_elm.load("jStorage");
                }
                catch(E)
                {
                    // try to reset cache
                    _storage_elm.setAttribute("jStorage", "{}");
                    _storage_elm.save("jStorage");
                    _storage_elm.load("jStorage");
                }

                var data = "{}";
                try
                {
                    data = _storage_elm.getAttribute("jStorage");
                }
                catch(E5)
                {
                }

                try
                {
                    _observer_update = _storage_elm.getAttribute("jStorage_update");
                }
                catch(E6)
                {
                }

                _storage_service.jStorage = data;
                _backend = "userDataBehavior";
            }
            else
            {
                _storage_elm = null;
                return;
            }
        }

        // Load data from storage
        _load_storage();

        // remove dead keys
        _handleTTL();

        // start listening for changes
        _setupObserver();

        // initialize publish-subscribe service
        _handlePubSub();

        // handle cached navigation
        if("addEventListener" in window)
        {
            window.addEventListener("pageshow", function(event){
                if(event.persisted)
                {
                    _storageObserver();
                }
            }, false);
        }
    }

    /**
     * Reload data from storage when needed
     */
    function _reloadData()
    {
        var data = "{}";

        if(_backend == "userDataBehavior")
        {
            _storage_elm.load("jStorage");

            try
            {
                data = _storage_elm.getAttribute("jStorage");
            }
            catch(E5)
            {
            }

            try
            {
                _observer_update = _storage_elm.getAttribute("jStorage_update");
            }
            catch(E6)
            {
            }

            _storage_service.jStorage = data;
        }

        _load_storage();

        // remove dead keys
        _handleTTL();

        _handlePubSub();
    }

    /**
     * Sets up a storage change observer
     */
    function _setupObserver()
    {
        if(_backend == "localStorage" || _backend == "globalStorage")
        {
            if("addEventListener" in window)
            {
                window.addEventListener("storage", _storageObserver, false);
            }
            else
            {
                document.attachEvent("onstorage", _storageObserver);
            }
        }
        else if(_backend == "userDataBehavior")
        {
            setInterval(_storageObserver, 1000);
        }
    }

    /**
     * Fired on any kind of data change, needs to check if anything has
     * really been changed
     */
    function _storageObserver()
    {
        var updateTime;
        // cumulate change notifications with timeout
        clearTimeout(_observer_timeout);
        _observer_timeout = setTimeout(function(){

            if(_backend == "localStorage" || _backend == "globalStorage")
            {
                updateTime = _storage_service.jStorage_update;
            }
            else if(_backend == "userDataBehavior")
            {
                _storage_elm.load("jStorage");
                try
                {
                    updateTime = _storage_elm.getAttribute("jStorage_update");
                }
                catch(E5)
                {
                }
            }

            if(updateTime && updateTime != _observer_update)
            {
                _observer_update = updateTime;
                _checkUpdatedKeys();
            }

        }, 25);
    }

    /**
     * Reloads the data and checks if any keys are changed
     */
    function _checkUpdatedKeys()
    {
        var oldCrc32List = JSON.parse(JSON.stringify(_storage.__jstorage_meta.CRC32)),
            newCrc32List;

        _reloadData();
        newCrc32List = JSON.parse(JSON.stringify(_storage.__jstorage_meta.CRC32));

        var key,
            updated = [],
            removed = [];

        for(key in oldCrc32List)
        {
            if(oldCrc32List.hasOwnProperty(key))
            {
                if(!newCrc32List[key])
                {
                    removed.push(key);
                    continue;
                }
                if(oldCrc32List[key] != newCrc32List[key] && String(oldCrc32List[key]).substr(0, 2) == "2.")
                {
                    updated.push(key);
                }
            }
        }

        for(key in newCrc32List)
        {
            if(newCrc32List.hasOwnProperty(key))
            {
                if(!oldCrc32List[key])
                {
                    updated.push(key);
                }
            }
        }

        _fireObservers(updated, "updated");
        _fireObservers(removed, "deleted");
    }

    /**
     * Fires observers for updated keys
     *
     * @param {Array|String} keys Array of key names or a key
     * @param {String} action What happened with the value (updated, deleted, flushed)
     */
    function _fireObservers(keys, action)
    {
        keys = [].concat(keys || []);
        if(action == "flushed")
        {
            keys = [];
            for(var key in _observers)
            {
                if(_observers.hasOwnProperty(key))
                {
                    keys.push(key);
                }
            }
            action = "deleted";
        }
        for(var i = 0, len = keys.length ; i < len ; i++)
        {
            if(_observers[keys[i]])
            {
                for(var j = 0, jlen = _observers[keys[i]].length ; j < jlen ; j++)
                {
                    _observers[keys[i]][j](keys[i], action);
                }
            }
            if(_observers["*"])
            {
                for(var j = 0, jlen = _observers["*"].length ; j < jlen ; j++)
                {
                    _observers["*"][j](keys[i], action);
                }
            }
        }
    }

    /**
     * Publishes key change to listeners
     */
    function _publishChange()
    {
        var updateTime = (+new Date()).toString();

        if(_backend == "localStorage" || _backend == "globalStorage")
        {
            _storage_service.jStorage_update = updateTime;
        }
        else if(_backend == "userDataBehavior")
        {
            _storage_elm.setAttribute("jStorage_update", updateTime);
            _storage_elm.save("jStorage");
        }

        _storageObserver();
    }

    /**
     * Loads the data from the storage based on the supported mechanism
     */
    function _load_storage()
    {
        /* if jStorage string is retrieved, then decode it */
        if(_storage_service.jStorage)
        {
            try
            {
                _storage = JSON.parse(String(_storage_service.jStorage));
            }
            catch(E6)
            {
                _storage_service.jStorage = "{}";
            }
        }
        else
        {
            _storage_service.jStorage = "{}";
        }
        _storage_size = _storage_service.jStorage? String(_storage_service.jStorage).length : 0;

        if(!_storage.__jstorage_meta)
        {
            _storage.__jstorage_meta = {};
        }
        if(!_storage.__jstorage_meta.CRC32)
        {
            _storage.__jstorage_meta.CRC32 = {};
        }
    }

    /**
     * This functions provides the "save" mechanism to store the jStorage object
     */
    function _save()
    {
        _dropOldEvents(); // remove expired events
        try
        {
            _storage_service.jStorage = JSON.stringify(_storage);
            // If userData is used as the storage engine, additional
            if(_storage_elm)
            {
                _storage_elm.setAttribute("jStorage", _storage_service.jStorage);
                _storage_elm.save("jStorage");
            }
            _storage_size = _storage_service.jStorage? String(_storage_service.jStorage).length : 0;
        }
        catch(E7)
        {/* probably cache is full, nothing is saved this way*/
        }
    }

    /**
     * Function checks if a key is set and is string or numberic
     *
     * @param {String} key Key name
     */
    function _checkKey(key)
    {
        if(!key || (typeof key != "string" && typeof key != "number"))
        {
            throw new TypeError('Key name must be string or numeric');
        }
        if(key == "__jstorage_meta")
        {
            throw new TypeError('Reserved key name');
        }
        return true;
    }

    /**
     * Removes expired keys
     */
    function _handleTTL()
    {
        var curtime, i, TTL, CRC32, nextExpire = Infinity, changed = false, deleted = [];

        clearTimeout(_ttl_timeout);

        if(!_storage.__jstorage_meta || typeof _storage.__jstorage_meta.TTL != "object")
        {
            // nothing to do here
            return;
        }

        curtime = +new Date();
        TTL = _storage.__jstorage_meta.TTL;

        CRC32 = _storage.__jstorage_meta.CRC32;
        for(i in TTL)
        {
            if(TTL.hasOwnProperty(i))
            {
                if(TTL[i] <= curtime)
                {
                    delete TTL[i];
                    delete CRC32[i];
                    delete _storage[i];
                    changed = true;
                    deleted.push(i);
                }
                else if(TTL[i] < nextExpire)
                {
                    nextExpire = TTL[i];
                }
            }
        }

        // set next check
        if(nextExpire != Infinity)
        {
            _ttl_timeout = setTimeout(_handleTTL, nextExpire - curtime);
        }

        // save changes
        if(changed)
        {
            _save();
            _publishChange();
            _fireObservers(deleted, "deleted");
        }
    }

    /**
     * Checks if there's any events on hold to be fired to listeners
     */
    function _handlePubSub()
    {
        var i, len;
        if(!_storage.__jstorage_meta.PubSub)
        {
            return;
        }
        var pubelm,
            _pubsubCurrent = _pubsub_last;

        for(i = len = _storage.__jstorage_meta.PubSub.length - 1 ; i >= 0 ; i--)
        {
            pubelm = _storage.__jstorage_meta.PubSub[i];
            if(pubelm[0] > _pubsub_last)
            {
                _pubsubCurrent = pubelm[0];
                _fireSubscribers(pubelm[1], pubelm[2]);
            }
        }

        _pubsub_last = _pubsubCurrent;
    }

    /**
     * Fires all subscriber listeners for a pubsub channel
     *
     * @param {String} channel Channel name
     * @param {Mixed} payload Payload data to deliver
     */
    function _fireSubscribers(channel, payload)
    {
        if(_pubsub_observers[channel])
        {
            for(var i = 0, len = _pubsub_observers[channel].length ; i < len ; i++)
            {
                // send immutable data that can't be modified by listeners
                _pubsub_observers[channel][i](channel, JSON.parse(JSON.stringify(payload)));
            }
        }
    }

    /**
     * Remove old events from the publish stream (at least 2sec old)
     */
    function _dropOldEvents()
    {
        if(!_storage.__jstorage_meta.PubSub)
        {
            return;
        }

        var retire = +new Date() - 2000;

        for(var i = 0, len = _storage.__jstorage_meta.PubSub.length ; i < len ; i++)
        {
            if(_storage.__jstorage_meta.PubSub[i][0] <= retire)
            {
                // deleteCount is needed for IE6
                _storage.__jstorage_meta.PubSub.splice(i, _storage.__jstorage_meta.PubSub.length - i);
                break;
            }
        }

        if(!_storage.__jstorage_meta.PubSub.length)
        {
            delete _storage.__jstorage_meta.PubSub;
        }

    }

    /**
     * Publish payload to a channel
     *
     * @param {String} channel Channel name
     * @param {Mixed} payload Payload to send to the subscribers
     */
    function _publish(channel, payload)
    {
        if(!_storage.__jstorage_meta)
        {
            _storage.__jstorage_meta = {};
        }
        if(!_storage.__jstorage_meta.PubSub)
        {
            _storage.__jstorage_meta.PubSub = [];
        }

        _storage.__jstorage_meta.PubSub.unshift([+new Date, channel, payload]);

        _save();
        _publishChange();
    }

    /**
     * JS Implementation of MurmurHash2
     *
     *  SOURCE: https://github.com/garycourt/murmurhash-js (MIT licensed)
     *
     * @author <a href="mailto:gary.court@gmail.com">Gary Court</a>
     * @see http://github.com/garycourt/murmurhash-js
     * @author <a href="mailto:aappleby@gmail.com">Austin Appleby</a>
     * @see http://sites.google.com/site/murmurhash/
     *
     * @param {string} str ASCII only
     * @param {number} seed Positive integer only
     * @return {number} 32-bit positive integer hash
     */

    function murmurhash2_32_gc(str, seed)
    {
        var
            l = str.length,
            h = seed ^ l,
            i = 0,
            k;

        while(l >= 4)
        {
            k =
                ((str.charCodeAt(i) & 0xff)) |
                ((str.charCodeAt(++i) & 0xff) << 8) |
                ((str.charCodeAt(++i) & 0xff) << 16) |
                ((str.charCodeAt(++i) & 0xff) << 24);

            k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));
            k ^= k >>> 24;
            k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));

            h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16)) ^ k;

            l -= 4;
            ++i;
        }

        switch(l)
        {
            case 3:
                h ^= (str.charCodeAt(i + 2) & 0xff) << 16;
            case 2:
                h ^= (str.charCodeAt(i + 1) & 0xff) << 8;
            case 1:
                h ^= (str.charCodeAt(i) & 0xff);
                h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
        }

        h ^= h >>> 13;
        h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
        h ^= h >>> 15;

        return h >>> 0;
    }

    ////////////////////////// PUBLIC INTERFACE /////////////////////////

    $.jStorage = {
        /* Version number */
        version: JSTORAGE_VERSION,

        /**
         * Sets a key's value.
         *
         * @param {String} key Key to set. If this value is not set or not
         *              a string an exception is raised.
         * @param {Mixed} value Value to set. This can be any value that is JSON
         *              compatible (Numbers, Strings, Objects etc.).
         * @param {Object} [options] - possible options to use
         * @param {Number} [options.TTL] - optional TTL value
         * @return {Mixed} the used value
         */
        set: function(key, value, options){
            _checkKey(key);

            options = options || {};

            // undefined values are deleted automatically
            if(typeof value == "undefined")
            {
                this.deleteKey(key);
                return value;
            }

            if(_XMLService.isXML(value))
            {
                value = {_is_xml: true, xml: _XMLService.encode(value)};
            }
            else if(typeof value == "function")
            {
                return undefined; // functions can't be saved!
            }
            else if(value && typeof value == "object")
            {
                // clone the object before saving to _storage mcxtree
                value = JSON.parse(JSON.stringify(value));
            }

            _storage[key] = value;

            _storage.__jstorage_meta.CRC32[key] = "2." + murmurhash2_32_gc(JSON.stringify(value), 0x9747b28c);

            this.setTTL(key, options.TTL || 0); // also handles saving and _publishChange

            _fireObservers(key, "updated");
            return value;
        },

        /**
         * Looks up a key in cache
         *
         * @param {String} key - Key to look up.
         * @param {mixed} def - Default value to return, if key didn't exist.
         * @return {Mixed} the key value, default value or null
         */
        get: function(key, def){
            _checkKey(key);
            if(key in _storage)
            {
                if(_storage[key] && typeof _storage[key] == "object" && _storage[key]._is_xml)
                {
                    return _XMLService.decode(_storage[key].xml);
                }
                else
                {
                    return _storage[key];
                }
            }
            return typeof(def) == 'undefined'? null : def;
        },

        /**
         * Deletes a key from cache.
         *
         * @param {String} key - Key to delete.
         * @return {Boolean} true if key existed or false if it didn't
         */
        deleteKey: function(key){
            _checkKey(key);
            if(key in _storage)
            {
                delete _storage[key];
                // remove from TTL list
                if(typeof _storage.__jstorage_meta.TTL == "object" &&
                    key in _storage.__jstorage_meta.TTL)
                {
                    delete _storage.__jstorage_meta.TTL[key];
                }

                delete _storage.__jstorage_meta.CRC32[key];

                _save();
                _publishChange();
                _fireObservers(key, "deleted");
                return true;
            }
            return false;
        },

        /**
         * Sets a TTL for a key, or remove it if ttl value is 0 or below
         *
         * @param {String} key - key to set the TTL for
         * @param {Number} ttl - TTL timeout in milliseconds
         * @return {Boolean} true if key existed or false if it didn't
         */
        setTTL: function(key, ttl){
            var curtime = +new Date();
            _checkKey(key);
            ttl = Number(ttl) || 0;
            if(key in _storage)
            {

                if(!_storage.__jstorage_meta.TTL)
                {
                    _storage.__jstorage_meta.TTL = {};
                }

                // Set TTL value for the key
                if(ttl > 0)
                {
                    _storage.__jstorage_meta.TTL[key] = curtime + ttl;
                }
                else
                {
                    delete _storage.__jstorage_meta.TTL[key];
                }

                _save();

                _handleTTL();

                _publishChange();
                return true;
            }
            return false;
        },

        /**
         * Gets remaining TTL (in milliseconds) for a key or 0 when no TTL has been set
         *
         * @param {String} key Key to check
         * @return {Number} Remaining TTL in milliseconds
         */
        getTTL: function(key){
            var curtime = +new Date(), ttl;
            _checkKey(key);
            if(key in _storage && _storage.__jstorage_meta.TTL && _storage.__jstorage_meta.TTL[key])
            {
                ttl = _storage.__jstorage_meta.TTL[key] - curtime;
                return ttl || 0;
            }
            return 0;
        },

        /**
         * Deletes everything in cache.
         *
         * @return {Boolean} Always true
         */
        flush: function(){
            _storage = {__jstorage_meta: {CRC32: {}}};
            _save();
            _publishChange();
            _fireObservers(null, "flushed");
            return true;
        },

        /**
         * Returns a read-only copy of _storage
         *
         * @return {Object} Read-only copy of _storage
         */
        storageObj: function(){
            function F()
            {
            }

            F.prototype = _storage;
            return new F();
        },

        /**
         * Returns an index of all used keys as an array
         * ['key1', 'key2',..'keyN']
         *
         * @return {Array} Used keys
         */
        index: function(){
            var index = [], i;
            for(i in _storage)
            {
                if(_storage.hasOwnProperty(i) && i != "__jstorage_meta")
                {
                    index.push(i);
                }
            }
            return index;
        },

        /**
         * How much space in bytes does the storage take?
         *
         * @return {Number} Storage size in chars (not the same as in bytes,
         *                  since some chars may take several bytes)
         */
        storageSize: function(){
            return _storage_size;
        },

        /**
         * Which backend is currently in use?
         *
         * @return {String} Backend name
         */
        currentBackend: function(){
            return _backend;
        },

        /**
         * Test if storage is available
         *
         * @return {Boolean} True if storage can be used
         */
        storageAvailable: function(){
            return !!_backend;
        },

        /**
         * Register change listeners
         *
         * @param {String} key Key name
         * @param {Function} callback Function to run when the key changes
         */
        listenKeyChange: function(key, callback){
            _checkKey(key);
            if(!_observers[key])
            {
                _observers[key] = [];
            }
            _observers[key].push(callback);
        },

        /**
         * Remove change listeners
         *
         * @param {String} key Key name to unregister listeners against
         * @param {Function} [callback] If set, unregister the callback, if not - unregister all
         */
        stopListening: function(key, callback){
            _checkKey(key);

            if(!_observers[key])
            {
                return;
            }

            if(!callback)
            {
                delete _observers[key];
                return;
            }

            for(var i = _observers[key].length - 1 ; i >= 0 ; i--)
            {
                if(_observers[key][i] == callback)
                {
                    _observers[key].splice(i, 1);
                }
            }
        },

        /**
         * Subscribe to a Publish/Subscribe event stream
         *
         * @param {String} channel Channel name
         * @param {Function} callback Function to run when the something is published to the channel
         */
        subscribe: function(channel, callback){
            channel = (channel || "").toString();
            if(!channel)
            {
                throw new TypeError('Channel not defined');
            }
            if(!_pubsub_observers[channel])
            {
                _pubsub_observers[channel] = [];
            }
            _pubsub_observers[channel].push(callback);
        },

        /**
         * Publish data to an event stream
         *
         * @param {String} channel Channel name
         * @param {Mixed} payload Payload to deliver
         */
        publish: function(channel, payload){
            channel = (channel || "").toString();
            if(!channel)
            {
                throw new TypeError('Channel not defined');
            }

            _publish(channel, payload);
        },

        /**
         * Reloads the data from browser storage
         */
        reInit: function(){
            _reloadData();
        }
    };

    // Initialize jStorage
    _init();

})();

// jquerylocalize

(function($){
    var normaliseLang;
    normaliseLang = function(lang){
        lang = lang.replace(/_/, '-').toLowerCase();
        if(lang.length > 3)
        {
            lang = lang.substring(0, 2);
        }
        return lang;
    };
    $.defaultLanguage = normaliseLang(navigator.languages && navigator.languages.length > 0? navigator.languages[0] : navigator.language || navigator.userLanguage);
    $.localize = function(pkg, options){
        var defaultCallback, deferred, fileExtension, intermediateLangData, jsonCall, lang, loadLanguage,
            localizeElement, localizeForSpecialKeys, localizeImageElement, localizeInputElement,
            localizeForSpecialAttribute, localizeOptgroupElement, notifyDelegateLanguageLoaded, regexify,
            setAttrFromValueForKey, setTextFromValueForKey, valueForKey, wrappedSet;
        if(options == null)
        {
            options = {};
        }
        wrappedSet = this;
        intermediateLangData = {};
        fileExtension = options.fileExtension || "json";
        deferred = $.Deferred();
        loadLanguage = function(pkg, lang, level){
            var file;
            if(level == null)
            {
                level = 1;
            }
            switch(level)
            {
                case 1:
                    intermediateLangData = {};
                    if(options.loadBase)
                    {
                        file = pkg + ("." + fileExtension);
                        return jsonCall(file, pkg, lang, level);
                    }
                    else
                    {
                        return loadLanguage(pkg, lang, 2);
                    }
                    break;
                case 2:
                    file = "" + pkg + "-" + (lang.split('-')[0]) + "." + fileExtension;
                    return jsonCall(file, pkg, lang, level);
                case 3:
                    file = "" + pkg + "-" + (lang.split('-').slice(0, 2).join('-')) + "." + fileExtension;
                    return jsonCall(file, pkg, lang, level);
                default:
                    return deferred.resolve();
            }
        };
        jsonCall = function(file, pkg, lang, level){

            var ajaxOptions, errorFunc, successFunc;
            if(options.pathPrefix != null)
            {
                file = "" + options.pathPrefix + "/" + file;
            }
            successFunc = function(d){
                $.extend(intermediateLangData, d);
                notifyDelegateLanguageLoaded(intermediateLangData);
                return loadLanguage(pkg, lang, level + 1);
            };
            errorFunc = function(){
                if(level === 2 && lang.indexOf('-') > -1)
                {
                    return loadLanguage(pkg, lang, level + 1);
                }
                else if(options.fallback && options.fallback !== lang)
                {
                    return loadLanguage(pkg, options.fallback);
                }
            };
            ajaxOptions = {
                url     : file,
                dataType: "json",
                async   : true,
                timeout : options.timeout != null? options.timeout : 500,
                success : successFunc,
                error   : errorFunc
            };
            if(window.location.protocol === "file:")
            {
                ajaxOptions.error = function(xhr){
                    return successFunc($.parseJSON(xhr.responseText));
                };
            }

            return $.ajax(ajaxOptions);
        };
        notifyDelegateLanguageLoaded = function(data){
            if(options.callback != null)
            {
                return options.callback(data, defaultCallback);
            }
            else
            {
                return defaultCallback(data);
            }
        };
        defaultCallback = function(data){
            $.localize.data[pkg] = data;
            return wrappedSet.each(function(){
                var elem, key, value;
                elem = $(this);
                key = elem.attr("data-localize") || elem.data("localize");
                //key || (key = elem.attr("rel").match(/localize\[(.*?)\]/)[1]);
                value = valueForKey(key, data);
                if(value != null)
                {
                    return localizeElement(elem, key, value);
                }
            });
        };
        localizeElement = function(elem, key, value){
            if(elem.is('[data-localize-for]'))
            {
                localizeForSpecialAttribute(elem, key, value);
            }
            else if(elem.is('input'))
            {
                localizeInputElement(elem, key, value);
            }
            else if(elem.is('textarea'))
            {
                localizeInputElement(elem, key, value);
            }
            else if(elem.is('img'))
            {
                localizeImageElement(elem, key, value);
            }
            else if(elem.is('optgroup'))
            {
                localizeOptgroupElement(elem, key, value);
            }
            else if(!$.isPlainObject(value))
            {
                elem.html(value);
            }
            if($.isPlainObject(value))
            {
                return localizeForSpecialKeys(elem, value);
            }
        };
        localizeForSpecialAttribute = function(elem, key, value){
            var attrValue = elem.attr('data-localize-for');

            var values = attrValue.split(',');
            for(var i in values)
            {
                var val = values[i];
                if(value != null && val == 'content')
                    elem.html(value);
                else if(value != null && val != null)
                    elem.attr(val, value);
            }
            return elem;
        };
        localizeInputElement = function(elem, key, value){
            var val;
            val = $.isPlainObject(value)? value.value : value;
            if(elem.is("[placeholder]"))
            {
                return elem.attr("placeholder", val);
            }
            else
            {
                return elem.val(val);
            }
        };
        localizeForSpecialKeys = function(elem, value){
            setAttrFromValueForKey(elem, "title", value);
            setAttrFromValueForKey(elem, "href", value);
            return setTextFromValueForKey(elem, "text", value);
        };
        localizeOptgroupElement = function(elem, key, value){
            return elem.attr("label", value);
        };
        localizeImageElement = function(elem, key, value){
            setAttrFromValueForKey(elem, "alt", value);
            return setAttrFromValueForKey(elem, "src", value);
        };
        valueForKey = function(key, data){
            if(!key)
                return null;

            var keys, value, _i, _len;
            keys = key.split(/\./);
            value = data;
            for(_i = 0, _len = keys.length ; _i < _len ; _i++)
            {
                key = keys[_i];
                value = value != null? value[key] : null;
            }
            return value;
        };
        setAttrFromValueForKey = function(elem, key, value){
            value = valueForKey(key, value);
            if(value != null)
            {
                return elem.attr(key, value);
            }
        };
        setTextFromValueForKey = function(elem, key, value){
            value = valueForKey(key, value);
            if(value != null)
            {
                return elem.text(value);
            }
        };
        regexify = function(string_or_regex_or_array){
            var thing;
            if(typeof string_or_regex_or_array === "string")
            {
                return "^" + string_or_regex_or_array + "$";
            }
            else if(string_or_regex_or_array.length != null)
            {
                return ((function(){
                    var _i, _len, _results;
                    _results = [];
                    for(_i = 0, _len = string_or_regex_or_array.length ; _i < _len ; _i++)
                    {
                        thing = string_or_regex_or_array[_i];
                        _results.push(regexify(thing));
                    }
                    return _results;
                })()).join("|");
            }
            else
            {
                return string_or_regex_or_array;
            }
        };
        lang = normaliseLang(options.language? options.language : $.defaultLanguage);
        if(options.skipLanguage && lang.match(regexify(options.skipLanguage)))
        {
            deferred.resolve();
        }
        else
        {
            loadLanguage(pkg, lang, 1);
        }
        wrappedSet.localizePromise = deferred;
        return wrappedSet;
    };
    $.fn.localize = $.localize;
    return $.localize.data = {};
})(jQuery);

//jquery ddslick

(function(a){
    function g(a, b)
    {
        var c = a.data("ddslick");
        var d = a.find(".dd-selected"), e = d.siblings(".dd-selected-value"), f = a.find(".dd-options"),
            g = d.siblings(".dd-pointer"), h = a.find(".dd-option").eq(b), k = h.closest("li"), l = c.settings,
            m = c.settings.data[b];
        a.find(".dd-option").removeClass("dd-option-selected");
        h.addClass("dd-option-selected");
        c.selectedIndex = b;
        c.selectedItem = k;
        c.selectedData = m;
        if(l.showSelectedHTML)
        {
            d.html((m.imageSrc? '<img class="dd-selected-image' + (l.imagePosition == "right"? " dd-image-right" : "") + '" src="' + m.imageSrc + '" />' : "") + (m.text? '<label class="dd-selected-text">' + m.text + "</label>" : "") + (m.description? '<small class="dd-selected-description dd-desc' + (l.truncateDescription? " dd-selected-description-truncated" : "") + '" >' + m.description + "</small>" : ""))
        }
        else d.html(m.text);
        e.val(m.value);
        c.original.val(m.value);
        a.data("ddslick", c);
        i(a);
        j(a);
        if(typeof l.onSelected == "function")
        {
            l.onSelected.call(this, c)
        }
    }

    function h(b)
    {
        var c = b.find(".dd-select"), d = c.siblings(".dd-options"), e = c.find(".dd-pointer"), f = d.is(":visible");
        a(".dd-click-off-close").not(d).slideUp(50);
        a(".dd-pointer").removeClass("dd-pointer-up");
        if(f)
        {
            d.slideUp("fast");
            e.removeClass("dd-pointer-up")
        }
        else
        {
            d.slideDown("fast");
            e.addClass("dd-pointer-up")
        }
        k(b)
    }

    function i(a)
    {
        a.find(".dd-options").slideUp(50);
        a.find(".dd-pointer").removeClass("dd-pointer-up").removeClass("dd-pointer-up")
    }

    function j(a)
    {
        var b = a.find(".dd-select").css("height");
        var c = a.find(".dd-selected-description");
        var d = a.find(".dd-selected-image");
        if(c.length <= 0 && d.length > 0)
        {
            a.find(".dd-selected-text").css("lineHeight", b)
        }
    }

    function k(b)
    {
        b.find(".dd-option").each(function(){
            var c = a(this);
            var d = c.css("height");
            var e = c.find(".dd-option-description");
            var f = b.find(".dd-option-image");
            if(e.length <= 0 && f.length > 0)
            {
                c.find(".dd-option-text").css("lineHeight", d)
            }
        })
    }

    a.fn.ddslick = function(c){
        if(b[c])
        {
            return b[c].apply(this, Array.prototype.slice.call(arguments, 1))
        }
        else if(typeof c === "object" || !c)
        {
            return b.init.apply(this, arguments)
        }
        else
        {
            a.error("Method " + c + " does not exists.")
        }
    };
    var b = {}, c = {
            data: [],
            keepJSONItemsOnTop: false,
            width: 260,
            height: null,
            background: "#eee",
            selectText: "",
            defaultSelectedIndex: null,
            truncateDescription: true,
            imagePosition: "left",
            showSelectedHTML: true,
            clickOffToClose: true,
            onSelected: function(){
            }
        },
        d = '<div class="dd-select"><input class="dd-selected-value" type="hidden" /><a class="dd-selected"></a><span class="dd-pointer dd-pointer-down"></span></div>',
        e = '<ul class="dd-options"></ul>',
        f = '<style id="css-ddslick" type="text/css">' + ".dd-select{ border-radius:2px; border:solid 1px #ccc; position:relative; cursor:pointer;}" + ".dd-desc { color:#aaa; display:block; overflow: hidden; font-weight:normal; line-height: 1.4em; }" + ".dd-selected{ overflow:hidden; display:block; padding:10px; font-weight:bold;}" + ".dd-pointer{ width:0; height:0; position:absolute; right:10px; top:50%; margin-top:-3px;}" + ".dd-pointer-down{ border:solid 5px transparent; border-top:solid 5px #000; }" + ".dd-pointer-up{border:solid 5px transparent !important; border-bottom:solid 5px #000 !important; margin-top:-8px;}" + ".dd-options{ border:solid 1px #ccc; border-top:none; list-style:none; box-shadow:0px 1px 5px #ddd; display:none; position:absolute; z-index:2000; margin:0; padding:0;background:#fff; overflow:auto;}" + ".dd-option{ padding:10px; display:block; border-bottom:solid 1px #ddd; overflow:hidden; text-decoration:none; color:#333; cursor:pointer;-webkit-transition: all 0.25s ease-in-out; -moz-transition: all 0.25s ease-in-out;-o-transition: all 0.25s ease-in-out;-ms-transition: all 0.25s ease-in-out; }" + ".dd-options > li:last-child > .dd-option{ border-bottom:none;}" + ".dd-option:hover{ background:#f3f3f3; color:#000;}" + ".dd-selected-description-truncated { text-overflow: ellipsis; white-space:nowrap; }" + ".dd-option-selected { background:#f6f6f6; }" + ".dd-option-image, .dd-selected-image { vertical-align:middle; float:left; margin-right:5px; max-width:64px;}" + ".dd-image-right { float:right; margin-right:15px; margin-left:5px;}" + ".dd-container{position:fixed;z-index:9999;}? .dd-selected-text { font-weight:bold}?</style>";
    if(a("#css-ddslick").length <= 0)
    {
        a(f).appendTo("head")
    }
    b.init = function(b){
        var b = a.extend({}, c, b);
        return this.each(function(){
            var c = a(this), f = c.data("ddslick");
            if(!f)
            {
                var i = [], j = b.data;
                c.find("option").each(function(){
                    var b = a(this), c = b.data();
                    i.push({
                        text       : a.trim(b.text()),
                        value      : b.val(),
                        selected   : b.is(":selected"),
                        description: c.description,
                        imageSrc   : c.imagesrc
                    })
                });
                if(b.keepJSONItemsOnTop) a.merge(b.data, i);
                else b.data = a.merge(i, b.data);
                var k = c, l = a('<div id="' + c.attr("id") + '"></div>');
                c.replaceWith(l);
                c = l;
                c.addClass("dd-container").append(d).append(e);
                var i = c.find(".dd-select"), m = c.find(".dd-options");
                m.css({width: b.width});
                i.css({width: b.width, background: b.background});
                c.css({width: b.width});
                if(b.height != null) m.css({height: b.height, overflow: "auto"});
                a.each(b.data, function(a, c){
                    if(c.selected) b.defaultSelectedIndex = a;
                    m.append("<li>" + '<a class="dd-option">' + (c.value? ' <input class="dd-option-value" type="hidden" value="' + c.value + '" />' : "") + (c.imageSrc? ' <img class="dd-option-image' + (b.imagePosition == "right"? " dd-image-right" : "") + '" src="' + c.imageSrc + '" />' : "") + (c.text? ' <label class="dd-option-text">' + c.text + "</label>" : "") + (c.description? ' <small class="dd-option-description dd-desc">' + c.description + "</small>" : "") + "</a>" + "</li>")
                });
                var n = {settings: b, original: k, selectedIndex: -1, selectedItem: null, selectedData: null};
                c.data("ddslick", n);
                if(b.selectText.length > 0 && b.defaultSelectedIndex == null)
                {
                    c.find(".dd-selected").html(b.selectText)
                }
                else
                {
                    var o = b.defaultSelectedIndex != null && b.defaultSelectedIndex >= 0 && b.defaultSelectedIndex < b.data.length? b.defaultSelectedIndex : 0;
                    g(c, o)
                }
                c.find(".dd-select").on("click.ddslick", function(){
                    h(c)
                });
                c.find(".dd-option").on("click.ddslick", function(){
                    g(c, a(this).closest("li").index())
                });
                if(b.clickOffToClose)
                {
                    m.addClass("dd-click-off-close");
                    c.on("click.ddslick", function(a){
                        a.stopPropagation()
                    });
                    a("body").on("click", function(){
                        a(".dd-click-off-close").slideUp(50).siblings(".dd-select").find(".dd-pointer").removeClass("dd-pointer-up")
                    })
                }
            }
        })
    };
    b.select = function(b){
        return this.each(function(){
            if(b.index) g(a(this), b.index)
        })
    };
    b.open = function(){
        return this.each(function(){
            var b = a(this), c = b.data("ddslick");
            if(c) h(b)
        })
    };
    b.close = function(){
        return this.each(function(){
            var b = a(this), c = b.data("ddslick");
            if(c) i(b)
        })
    };
    b.destroy = function(){
        return this.each(function(){
            var b = a(this), c = b.data("ddslick");
            if(c)
            {
                var d = c.original;
                b.removeData("ddslick").unbind(".ddslick").replaceWith(d)
            }
        })
    }
})(jQuery)

//hammer
/*! Hammer.JS - v1.0.5 - 2013-04-07
 * http://eightmedia.github.com/hammer.js
 *
 * Copyright (c) 2013 Jorik Tangelder <j.tangelder@gmail.com>;
 * Licensed under the MIT license */

var Hammer = Hammer || {};
var module = module || {};
(function(t, e){
    "use strict";

    function n()
    {
        if(!i.READY)
        {
            i.event.determineEventTypes();
            for(var t in i.gestures) i.gestures.hasOwnProperty(t) && i.detection.register(i.gestures[t]);
            i.event.onTouch(i.DOCUMENT, i.EVENT_MOVE, i.detection.detect), i.event.onTouch(i.DOCUMENT, i.EVENT_END, i.detection.detect), i.READY = !0
        }
    }

    var i = function(t, e){
        return new i.Instance(t, e || {})
    };
    i.defaults = {
        stop_browser_behavior: {
            userSelect       : "none",
            touchAction      : "none",
            touchCallout     : "none",
            contentZooming   : "none",
            userDrag         : "none",
            tapHighlightColor: "rgba(0,0,0,0)"
        }
    }, i.HAS_POINTEREVENTS = navigator.pointerEnabled || navigator.msPointerEnabled, i.HAS_TOUCHEVENTS = "ontouchstart" in t, i.MOBILE_REGEX = /mobile|tablet|ip(ad|hone|od)|android/i, i.NO_MOUSEEVENTS = i.HAS_TOUCHEVENTS && navigator.userAgent.match(i.MOBILE_REGEX), i.EVENT_TYPES = {}, i.DIRECTION_DOWN = "down", i.DIRECTION_LEFT = "left", i.DIRECTION_UP = "up", i.DIRECTION_RIGHT = "right", i.POINTER_MOUSE = "mouse", i.POINTER_TOUCH = "touch", i.POINTER_PEN = "pen", i.EVENT_START = "start", i.EVENT_MOVE = "move", i.EVENT_END = "end", i.DOCUMENT = document, i.plugins = {}, i.READY = !1, i.Instance = function(t, e){
        var r = this;
        return n(), this.element = t, this.enabled = !0, this.options = i.utils.extend(i.utils.extend({}, i.defaults), e || {}), this.options.stop_browser_behavior && i.utils.stopDefaultBrowserBehavior(this.element, this.options.stop_browser_behavior), i.event.onTouch(t, i.EVENT_START, function(t){
            r.enabled && i.detection.startDetect(r, t)
        }), this
    }, i.Instance.prototype = {
        on        : function(t, e){
            for(var n = t.split(" "), i = 0 ; n.length > i ; i++) this.element.addEventListener(n[i], e, !1);
            return this
        }, off    : function(t, e){
            for(var n = t.split(" "), i = 0 ; n.length > i ; i++) this.element.removeEventListener(n[i], e, !1);
            return this
        }, trigger: function(t, e){
            var n = i.DOCUMENT.createEvent("Event");
            n.initEvent(t, !0, !0), n.gesture = e;
            var r = this.element;
            return i.utils.hasParent(e.target, r) && (r = e.target), r.dispatchEvent(n), this
        }, enable : function(t){
            return this.enabled = t, this
        }
    };
    var r = null, o = !1, s = !1;
    i.event = {
        bindDom               : function(t, e, n){
            for(var i = e.split(" "), r = 0 ; i.length > r ; r++) t.addEventListener(i[r], n, !1)
        }, onTouch            : function(t, e, n){
            var a = this;
            this.bindDom(t, i.EVENT_TYPES[e], function(c){
                var u = c.type.toLowerCase();
                if(!u.match(/mouse/) || !s)
                {
                    (u.match(/touch/) || u.match(/pointerdown/) || u.match(/mouse/) && 1 === c.which) && (o = !0), u.match(/touch|pointer/) && (s = !0);
                    var h = 0;
                    o && (i.HAS_POINTEREVENTS && e != i.EVENT_END? h = i.PointerEvent.updatePointer(e, c) : u.match(/touch/)? h = c.touches.length : s || (h = u.match(/up/)? 0 : 1), h > 0 && e == i.EVENT_END? e = i.EVENT_MOVE : h || (e = i.EVENT_END), h || null === r? r = c : c = r, n.call(i.detection, a.collectEventData(t, e, c)), i.HAS_POINTEREVENTS && e == i.EVENT_END && (h = i.PointerEvent.updatePointer(e, c))), h || (r = null, o = !1, s = !1, i.PointerEvent.reset())
                }
            })
        }, determineEventTypes: function(){
            var t;
            t = i.HAS_POINTEREVENTS? i.PointerEvent.getEvents() : i.NO_MOUSEEVENTS? ["touchstart", "touchmove", "touchend touchcancel"] : ["touchstart mousedown", "touchmove mousemove", "touchend touchcancel mouseup"], i.EVENT_TYPES[i.EVENT_START] = t[0], i.EVENT_TYPES[i.EVENT_MOVE] = t[1], i.EVENT_TYPES[i.EVENT_END] = t[2]
        }, getTouchList       : function(t){
            return i.HAS_POINTEREVENTS? i.PointerEvent.getTouchList() : t.touches? t.touches : [{
                identifier: 1,
                pageX     : t.pageX,
                pageY     : t.pageY,
                target    : t.target
            }]
        }, collectEventData   : function(t, e, n){
            var r = this.getTouchList(n, e), o = i.POINTER_TOUCH;
            return (n.type.match(/mouse/) || i.PointerEvent.matchType(i.POINTER_MOUSE, n)) && (o = i.POINTER_MOUSE), {
                center         : i.utils.getCenter(r),
                timeStamp      : (new Date).getTime(),
                target         : n.target,
                touches        : r,
                eventType      : e,
                pointerType    : o,
                srcEvent       : n,
                preventDefault : function(){
                    this.srcEvent.preventManipulation && this.srcEvent.preventManipulation(), this.srcEvent.preventDefault && this.srcEvent.preventDefault()
                },
                stopPropagation: function(){
                    this.srcEvent.stopPropagation()
                },
                stopDetect     : function(){
                    return i.detection.stopDetect()
                }
            }
        }
    }, i.PointerEvent = {
        pointers        : {}, getTouchList: function(){
            var t = this, e = [];
            return Object.keys(t.pointers).sort().forEach(function(n){
                e.push(t.pointers[n])
            }), e
        }, updatePointer: function(t, e){
            return t == i.EVENT_END? this.pointers = {} : (e.identifier = e.pointerId, this.pointers[e.pointerId] = e), Object.keys(this.pointers).length
        }, matchType    : function(t, e){
            if(!e.pointerType) return !1;
            var n = {};
            return n[i.POINTER_MOUSE] = e.pointerType == e.MSPOINTER_TYPE_MOUSE || e.pointerType == i.POINTER_MOUSE, n[i.POINTER_TOUCH] = e.pointerType == e.MSPOINTER_TYPE_TOUCH || e.pointerType == i.POINTER_TOUCH, n[i.POINTER_PEN] = e.pointerType == e.MSPOINTER_TYPE_PEN || e.pointerType == i.POINTER_PEN, n[t]
        }, getEvents    : function(){
            return ["pointerdown MSPointerDown", "pointermove MSPointerMove", "pointerup pointercancel MSPointerUp MSPointerCancel"]
        }, reset        : function(){
            this.pointers = {}
        }
    }, i.utils = {
        extend                       : function(t, n, i){
            for(var r in n) t[r] !== e && i || (t[r] = n[r]);
            return t
        }, hasParent                 : function(t, e){
            for(; t ;)
            {
                if(t == e) return !0;
                t = t.parentNode
            }
            return !1
        }, getCenter                 : function(t){
            for(var e = [], n = [], i = 0, r = t.length ; r > i ; i++) e.push(t[i].pageX), n.push(t[i].pageY);
            return {
                pageX: (Math.min.apply(Math, e) + Math.max.apply(Math, e)) / 2,
                pageY: (Math.min.apply(Math, n) + Math.max.apply(Math, n)) / 2
            }
        }, getVelocity               : function(t, e, n){
            return {x: Math.abs(e / t) || 0, y: Math.abs(n / t) || 0}
        }, getAngle                  : function(t, e){
            var n = e.pageY - t.pageY, i = e.pageX - t.pageX;
            return 180 * Math.atan2(n, i) / Math.PI
        }, getDirection              : function(t, e){
            var n = Math.abs(t.pageX - e.pageX), r = Math.abs(t.pageY - e.pageY);
            return n >= r? t.pageX - e.pageX > 0? i.DIRECTION_LEFT : i.DIRECTION_RIGHT : t.pageY - e.pageY > 0? i.DIRECTION_UP : i.DIRECTION_DOWN
        }, getDistance               : function(t, e){
            var n = e.pageX - t.pageX, i = e.pageY - t.pageY;
            return Math.sqrt(n * n + i * i)
        }, getScale                  : function(t, e){
            return t.length >= 2 && e.length >= 2? this.getDistance(e[0], e[1]) / this.getDistance(t[0], t[1]) : 1
        }, getRotation               : function(t, e){
            return t.length >= 2 && e.length >= 2? this.getAngle(e[1], e[0]) - this.getAngle(t[1], t[0]) : 0
        }, isVertical                : function(t){
            return t == i.DIRECTION_UP || t == i.DIRECTION_DOWN
        }, stopDefaultBrowserBehavior: function(t, e){
            var n, i = ["webkit", "khtml", "moz", "ms", "o", ""];
            if(e && t.style)
            {
                for(var r = 0 ; i.length > r ; r++) for(var o in e) e.hasOwnProperty(o) && (n = o, i[r] && (n = i[r] + n.substring(0, 1).toUpperCase() + n.substring(1)), t.style[n] = e[o]);
                "none" == e.userSelect && (t.onselectstart = function(){
                    return !1
                })
            }
        }
    }, i.detection = {
        gestures          : [], current: null, previous: null, stopped: !1, startDetect: function(t, e){
            this.current || (this.stopped = !1, this.current = {
                inst      : t,
                startEvent: i.utils.extend({}, e),
                lastEvent : !1,
                name      : ""
            }, this.detect(e))
        }, detect         : function(t){
            if(this.current && !this.stopped)
            {
                t = this.extendEventData(t);
                for(var e = this.current.inst.options, n = 0, r = this.gestures.length ; r > n ; n++)
                {
                    var o = this.gestures[n];
                    if(!this.stopped && e[o.name] !== !1 && o.handler.call(o, t, this.current.inst) === !1)
                    {
                        this.stopDetect();
                        break
                    }
                }
                return this.current && (this.current.lastEvent = t), t.eventType == i.EVENT_END && !t.touches.length - 1 && this.stopDetect(), t
            }
        }, stopDetect     : function(){
            this.previous = i.utils.extend({}, this.current), this.current = null, this.stopped = !0
        }, extendEventData: function(t){
            var e = this.current.startEvent;
            if(e && (t.touches.length != e.touches.length || t.touches === e.touches))
            {
                e.touches = [];
                for(var n = 0, r = t.touches.length ; r > n ; n++) e.touches.push(i.utils.extend({}, t.touches[n]))
            }
            var o = t.timeStamp - e.timeStamp, s = t.center.pageX - e.center.pageX, a = t.center.pageY - e.center.pageY,
                c = i.utils.getVelocity(o, s, a);
            return i.utils.extend(t, {
                deltaTime : o,
                deltaX    : s,
                deltaY    : a,
                velocityX : c.x,
                velocityY : c.y,
                distance  : i.utils.getDistance(e.center, t.center),
                angle     : i.utils.getAngle(e.center, t.center),
                direction : i.utils.getDirection(e.center, t.center),
                scale     : i.utils.getScale(e.touches, t.touches),
                rotation  : i.utils.getRotation(e.touches, t.touches),
                startEvent: e
            }), t
        }, register       : function(t){
            var n = t.defaults || {};
            return n[t.name] === e && (n[t.name] = !0), i.utils.extend(i.defaults, n, !0), t.index = t.index || 1e3, this.gestures.push(t), this.gestures.sort(function(t, e){
                return t.index < e.index? -1 : t.index > e.index? 1 : 0
            }), this.gestures
        }
    }, i.gestures = i.gestures || {}, i.gestures.Hold = {
        name    : "hold",
        index   : 10,
        defaults: {hold_timeout: 500, hold_threshold: 1},
        timer   : null,
        handler : function(t, e){
            switch(t.eventType)
            {
                case i.EVENT_START:
                    clearTimeout(this.timer), i.detection.current.name = this.name, this.timer = setTimeout(function(){
                        "hold" == i.detection.current.name && e.trigger("hold", t)
                    }, e.options.hold_timeout);
                    break;
                case i.EVENT_MOVE:
                    t.distance > e.options.hold_threshold && clearTimeout(this.timer);
                    break;
                case i.EVENT_END:
                    clearTimeout(this.timer)
            }
        }
    }, i.gestures.Tap = {
        name    : "tap",
        index   : 100,
        defaults: {
            tap_max_touchtime : 250,
            tap_max_distance  : 10,
            tap_always        : !0,
            doubletap_distance: 20,
            doubletap_interval: 300
        },
        handler : function(t, e){
            if(t.eventType == i.EVENT_END)
            {
                var n = i.detection.previous, r = !1;
                if(t.deltaTime > e.options.tap_max_touchtime || t.distance > e.options.tap_max_distance) return;
                n && "tap" == n.name && t.timeStamp - n.lastEvent.timeStamp < e.options.doubletap_interval && t.distance < e.options.doubletap_distance && (e.trigger("doubletap", t), r = !0), (!r || e.options.tap_always) && (i.detection.current.name = "tap", e.trigger(i.detection.current.name, t))
            }
        }
    }, i.gestures.Swipe = {
        name    : "swipe",
        index   : 40,
        defaults: {swipe_max_touches: 1, swipe_velocity: .7},
        handler : function(t, e){
            if(t.eventType == i.EVENT_END)
            {
                if(e.options.swipe_max_touches > 0 && t.touches.length > e.options.swipe_max_touches) return;
                (t.velocityX > e.options.swipe_velocity || t.velocityY > e.options.swipe_velocity) && (e.trigger(this.name, t), e.trigger(this.name + t.direction, t))
            }
        }
    }, i.gestures.Drag = {
        name     : "drag",
        index    : 50,
        defaults : {
            drag_min_distance     : 10,
            drag_max_touches      : 1,
            drag_block_horizontal : !1,
            drag_block_vertical   : !1,
            drag_lock_to_axis     : !1,
            drag_lock_min_distance: 25
        },
        triggered: !1,
        handler  : function(t, n){
            if(i.detection.current.name != this.name && this.triggered) return n.trigger(this.name + "end", t), this.triggered = !1, e;
            if(!(n.options.drag_max_touches > 0 && t.touches.length > n.options.drag_max_touches)) switch(t.eventType)
            {
                case i.EVENT_START:
                    this.triggered = !1;
                    break;
                case i.EVENT_MOVE:
                    if(t.distance < n.options.drag_min_distance && i.detection.current.name != this.name) return;
                    i.detection.current.name = this.name, (i.detection.current.lastEvent.drag_locked_to_axis || n.options.drag_lock_to_axis && n.options.drag_lock_min_distance <= t.distance) && (t.drag_locked_to_axis = !0);
                    var r = i.detection.current.lastEvent.direction;
                    t.drag_locked_to_axis && r !== t.direction && (t.direction = i.utils.isVertical(r)? 0 > t.deltaY? i.DIRECTION_UP : i.DIRECTION_DOWN : 0 > t.deltaX? i.DIRECTION_LEFT : i.DIRECTION_RIGHT), this.triggered || (n.trigger(this.name + "start", t), this.triggered = !0), n.trigger(this.name, t), n.trigger(this.name + t.direction, t), (n.options.drag_block_vertical && i.utils.isVertical(t.direction) || n.options.drag_block_horizontal && !i.utils.isVertical(t.direction)) && t.preventDefault();
                    break;
                case i.EVENT_END:
                    this.triggered && n.trigger(this.name + "end", t), this.triggered = !1
            }
        }
    }, i.gestures.Transform = {
        name     : "transform",
        index    : 45,
        defaults : {transform_min_scale: .01, transform_min_rotation: 1, transform_always_block: !1},
        triggered: !1,
        handler  : function(t, n){
            if(i.detection.current.name != this.name && this.triggered) return n.trigger(this.name + "end", t), this.triggered = !1, e;
            if(!(2 > t.touches.length)) switch(n.options.transform_always_block && t.preventDefault(), t.eventType)
            {
                case i.EVENT_START:
                    this.triggered = !1;
                    break;
                case i.EVENT_MOVE:
                    var r = Math.abs(1 - t.scale), o = Math.abs(t.rotation);
                    if(n.options.transform_min_scale > r && n.options.transform_min_rotation > o) return;
                    i.detection.current.name = this.name, this.triggered || (n.trigger(this.name + "start", t), this.triggered = !0), n.trigger(this.name, t), o > n.options.transform_min_rotation && n.trigger("rotate", t), r > n.options.transform_min_scale && (n.trigger("pinch", t), n.trigger("pinch" + (1 > t.scale? "in" : "out"), t));
                    break;
                case i.EVENT_END:
                    this.triggered && n.trigger(this.name + "end", t), this.triggered = !1
            }
        }
    }, i.gestures.Touch = {
        name    : "touch",
        index   : -1 / 0,
        defaults: {prevent_default: !1, prevent_mouseevents: !1},
        handler : function(t, n){
            return n.options.prevent_mouseevents && t.pointerType == i.POINTER_MOUSE? (t.stopDetect(), e) : (n.options.prevent_default && t.preventDefault(), t.eventType == i.EVENT_START && n.trigger(this.name, t), e)
        }
    }, i.gestures.Release = {
        name: "release", index: 1 / 0, handler: function(t, e){
            t.eventType == i.EVENT_END && e.trigger(this.name, t)
        }
    }, "object" == typeof module && "object" == typeof module.exports? module.exports = i : (t.Hammer = i, "function" == typeof t.define && t.define.amd && t.define("hammer", [], function(){
        return i
    }))
})(this);

/**
 * @enum {string}
 */
var McxGestureEventType =
    {
        'tap'       : 'tap',
        'doubletap' : 'doubletap',
        'swipe'     : 'swipe',
        'swipeup'   : 'swipeup',
        'swipedown' : 'swipedown',
        'swipeleft' : 'swipeleft',
        'swiperight': 'swiperight',
        'rotate'    : 'rotate',
        'pinch'     : 'pinch',
        'pinchin'   : 'pinchin',
        'pinchout'  : 'pinchout',
        'dragstart' : 'dragstart',
        'dragend'   : 'dragend',
        'drag'      : 'drag',
        'release'   : 'release',
        'hold'      : 'hold'
    }

//button group

/**
 * @private
 * @param {Array.<Object>} options
 * @returns {jQueryObject}
 */
$.createButton = function(options){
    var defaults = {
        appendTo: 'body',
        imgSrc  : null,
        text    : 'Button',
        onClick : null
    };

    var selections = $.extend({}, defaults, options);

    var appendTo = $(selections.appendTo);

    if(!appendTo)
        return null;

    var button = $('<div/>')
        .addClass('mcx-img-button');

    var buttonImg = $('<img/>')
        .attr('src', selections.imgSrc);

    button.append(buttonImg);

    var buttonText = $('<small/>')
        .html(selections.text);

    button.append(buttonText);

    appendTo.append(button);

    if(selections.onClick)
        button.click(selections.onClick);

    buttonImg.wrap('<div class="mcx-img-button-img-wrapper"/>');
    buttonText.wrap('<div class="mcx-img-button-text-wrapper"/>');

    return button;
}

/**
 * @private
 * @param {Array.<Object>} options
 */
$.fn.appendButton = function(options){
    options.appendTo = this;
    $.createButton(options);
};

/**
 * @private
 * @param {Array.<Object>} options
 */
$.fn.appendButtonForObjectList = function(options){
    var defaults = {
        objectList: null,
        imageField: null,
        textField : null,
        onClick   : null
    };

    var selections = $.extend({}, defaults, options);

    if(!selections.objectList || !selections.imageField || !selections.textField)
        return;

    var self = this;

    var buttonRow;
    for(var i in selections.objectList)
    {
        if(i % 4 == 0)
            buttonRow = $('<div/>')
                .css('display', 'table-row')
                .appendTo(self);

        var obj = selections.objectList[i];

        var creationOptions;
        creationOptions = {
            appendTo: buttonRow,
            imgSrc  : typeof obj[selections.imageField] === "function"? obj[selections.imageField]() : obj[selections.imageField],
            text    : typeof obj[selections.textField] === "function"? obj[selections.textField]() : obj[selections.textField],
            /**
             * @private
             */
            onClick : function(){
                if(selections.onClick)
                {
                    var obj = $(this).data('obj');
                    selections.onClick(obj);
                }
            }
        };

        var func = /** @type {Function} */ ($.createButton || $['createButton']);
        var button = func(creationOptions); //todo: sorunlu

        button.data('obj', obj);
    }

};

/**
 * @private
 * @param {Array.<Object>} options
 */
$.fn.makeAcordion = function(options){
    var defaults = {
        closed: false
    };

    var selections = $.extend({}, defaults, options);

    var domEle = $(this);

    var pageAreaDiv = domEle.find('.mcx-content-area');
    var pageAreaTitle = domEle.find('.mcx-content-area-title');

    pageAreaTitle.click(
        /**
         * @private
         */
        function(){
            pageAreaDiv.slideToggle(0);
        });
    ;

    if(selections.closed)
        pageAreaDiv.hide();
};

/**
 * @public
 * @param {Array.<Object>} options
 */
$.fn.groupedButtonList = function(options){
    var defaults = {
        objectList: null,
        imageField: null,
        textField : null,
        groupBy   : null,
        onClick   : null
    };

    var selections = $.extend({}, defaults, options);

    if(!selections.objectList || !selections.imageField || !selections.textField)
        return;

    var self = this;
    var groupByKeyList = [];
    var groupedObjectList = [];

    if(selections.groupBy)
    {
        for(var i in selections.objectList)
        {
            var obj = selections.objectList[i];
            var key = typeof obj[selections.groupBy] === "function"? obj[selections.groupBy]() : obj[selections.groupBy];
            key = key == ''? 'Default Group' : key;

            if(key && groupByKeyList.indexOf(key) == -1)
                groupByKeyList.push(key);
        }
    }

    if(groupByKeyList.length > 0)
    {
        for(var i in groupByKeyList)
        {
            var groupKey = groupByKeyList[i];
            var group = [];

            for(var k in selections.objectList)
            {
                var obj = selections.objectList[k];
                var objKey = typeof obj[selections.groupBy] === "function"? obj[selections.groupBy]() : obj[selections.groupBy];
                objKey = objKey == ''? 'Default Group' : objKey;
                if(obj && objKey == groupKey)
                    group.push(obj);
            }

            if(group.length > 0)
                groupedObjectList.push(group);
        }
    }

    for(var i in groupedObjectList)
    {
        var group = groupedObjectList[i];

        var representativeObject = group[0];

        var pageAreaContainerDiv = $('<div/>')
            .addClass('mcx-content-area-container');

        var groupTitle = typeof representativeObject[selections.groupBy] === "function"? representativeObject[selections.groupBy]() : representativeObject[selections.groupBy];
        groupTitle = groupTitle == ''? 'Default Group' : groupTitle;
        var titleDiv = $('<div/>')
            .addClass('mcx-content-area-title')
            .html(groupTitle);

        var pageAreaDiv = $('<div/>')
            .addClass('mcx-content-area');

        pageAreaContainerDiv.append(titleDiv);
        pageAreaContainerDiv.append(pageAreaDiv);

        pageAreaContainerDiv.makeAcordion({closed: i > 0});

        $(self).append(pageAreaContainerDiv);

        pageAreaDiv.appendButtonForObjectList({
            objectList: group,
            textField : selections.textField,
            imageField: selections.imageField,
            onClick   : selections.onClick
        });
    }
};

//colpick

(function($){
    var colpick = function(){
        var
            tpl = '<div class="colpick"><div class="colpick_color"><div class="colpick_color_overlay1"><div class="colpick_color_overlay2"><div class="colpick_selector_outer"><div class="colpick_selector_inner"></div></div></div></div></div><div class="colpick_hue"><div class="colpick_hue_arrs"><div class="colpick_hue_larr"></div><div class="colpick_hue_rarr"></div></div></div><div class="colpick_new_color"></div><div class="colpick_current_color"></div><div class="colpick_hex_field"><div class="colpick_field_letter">#</div><input type="text" maxlength="6" size="6" /></div><div class="colpick_rgb_r colpick_field"><div class="colpick_field_letter">R</div><input type="text" maxlength="3" size="3" /><div class="colpick_field_arrs"><div class="colpick_field_uarr"></div><div class="colpick_field_darr"></div></div></div><div class="colpick_rgb_g colpick_field"><div class="colpick_field_letter">G</div><input type="text" maxlength="3" size="3" /><div class="colpick_field_arrs"><div class="colpick_field_uarr"></div><div class="colpick_field_darr"></div></div></div><div class="colpick_rgb_b colpick_field"><div class="colpick_field_letter">B</div><input type="text" maxlength="3" size="3" /><div class="colpick_field_arrs"><div class="colpick_field_uarr"></div><div class="colpick_field_darr"></div></div></div><div class="colpick_hsb_h colpick_field"><div class="colpick_field_letter">H</div><input type="text" maxlength="3" size="3" /><div class="colpick_field_arrs"><div class="colpick_field_uarr"></div><div class="colpick_field_darr"></div></div></div><div class="colpick_hsb_s colpick_field"><div class="colpick_field_letter">S</div><input type="text" maxlength="3" size="3" /><div class="colpick_field_arrs"><div class="colpick_field_uarr"></div><div class="colpick_field_darr"></div></div></div><div class="colpick_hsb_b colpick_field"><div class="colpick_field_letter">B</div><input type="text" maxlength="3" size="3" /><div class="colpick_field_arrs"><div class="colpick_field_uarr"></div><div class="colpick_field_darr"></div></div></div><div class="colpick_submit"></div></div>',
            defaults = {
                showEvent   : 'click',
                onShow      : function(){
                },
                onBeforeShow: function(){
                },
                onHide      : function(){
                },
                onChange    : function(){
                },
                onSubmit    : function(){
                },
                colorScheme : 'light',
                color       : '3289c7',
                livePreview : true,
                flat        : false,
                mcxmcxlayout: 'full',
                submit      : 1,
                submitText  : 'OK',
                height      : 156
            },
            //Fill the inputs of the plugin
            fillRGBFields = function(hsb, cal){
                var rgb = hsbToRgb(hsb);
                $(cal).data('colpick').fields
                    .eq(1).val(rgb.r).end()
                    .eq(2).val(rgb.g).end()
                    .eq(3).val(rgb.b).end();
            },
            fillHSBFields = function(hsb, cal){
                $(cal).data('colpick').fields
                    .eq(4).val(Math.round(hsb.h)).end()
                    .eq(5).val(Math.round(hsb.s)).end()
                    .eq(6).val(Math.round(hsb.b)).end();
            },
            fillHexFields = function(hsb, cal){
                $(cal).data('colpick').fields.eq(0).val(hsbToHex(hsb));
            },
            //Set the round selector position
            setSelector = function(hsb, cal){
                $(cal).data('colpick').selector.css('backgroundColor', '#' + hsbToHex({h: hsb.h, s: 100, b: 100}));
                $(cal).data('colpick').selectorIndic.css({
                    left: parseInt($(cal).data('colpick').height * hsb.s / 100, 10),
                    top : parseInt($(cal).data('colpick').height * (100 - hsb.b) / 100, 10)
                });
            },
            //Set the hue selector position
            setHue = function(hsb, cal){
                $(cal).data('colpick').hue.css('top', parseInt($(cal).data('colpick').height - $(cal).data('colpick').height * hsb.h / 360, 10));
            },
            //Set current and new colors
            setCurrentColor = function(hsb, cal){
                $(cal).data('colpick').currentColor.css('backgroundColor', '#' + hsbToHex(hsb));
            },
            setNewColor = function(hsb, cal){
                $(cal).data('colpick').newColor.css('backgroundColor', '#' + hsbToHex(hsb));
            },
            //Called when the new color is changed
            change = function(ev){
                var cal = $(this).parent().parent(), col;
                if(this.parentNode.className.indexOf('_hex') > 0)
                {
                    cal.data('colpick').color = col = hexToHsb(fixHex(this.value));
                    fillRGBFields(col, cal.get(0));
                    fillHSBFields(col, cal.get(0));
                }
                else if(this.parentNode.className.indexOf('_hsb') > 0)
                {
                    cal.data('colpick').color = col = fixHSB({
                        h: parseInt(cal.data('colpick').fields.eq(4).val(), 10),
                        s: parseInt(cal.data('colpick').fields.eq(5).val(), 10),
                        b: parseInt(cal.data('colpick').fields.eq(6).val(), 10)
                    });
                    fillRGBFields(col, cal.get(0));
                    fillHexFields(col, cal.get(0));
                }
                else
                {
                    cal.data('colpick').color = col = rgbToHsb(fixRGB({
                        r: parseInt(cal.data('colpick').fields.eq(1).val(), 10),
                        g: parseInt(cal.data('colpick').fields.eq(2).val(), 10),
                        b: parseInt(cal.data('colpick').fields.eq(3).val(), 10)
                    }));
                    fillHexFields(col, cal.get(0));
                    fillHSBFields(col, cal.get(0));
                }
                setSelector(col, cal.get(0));
                setHue(col, cal.get(0));
                setNewColor(col, cal.get(0));
                cal.data('colpick').onChange.apply(cal.parent(), [col, hsbToHex(col), hsbToRgb(col)]);
            },
            //Change style on blur and on focus of inputs
            blur = function(ev){
                $(this).parent().removeClass('colpick_focus');
            },
            focus = function(){
                $(this).parent().parent().data('colpick').fields.parent().removeClass('colpick_focus');
                $(this).parent().addClass('colpick_focus');
            },
            //Increment/decrement arrows functions
            downIncrement = function(ev){
                ev.preventDefault? ev.preventDefault() : ev.returnValue = false;
                var field = $(this).parent().find('input').focus();
                var current = {
                    el     : $(this).parent().addClass('colpick_slider'),
                    max    : this.parentNode.className.indexOf('_hsb_h') > 0? 360 : (this.parentNode.className.indexOf('_hsb') > 0? 100 : 255),
                    y      : ev.pageY,
                    field  : field,
                    val    : parseInt(field.val(), 10),
                    preview: $(this).parent().parent().data('colpick').livePreview
                };
                $(document).mouseup(current, upIncrement);
                $(document).mousemove(current, moveIncrement);
            },
            moveIncrement = function(ev){
                ev.data.field.val(Math.max(0, Math.min(ev.data.max, parseInt(ev.data.val - ev.pageY + ev.data.y, 10))));
                if(ev.data.preview)
                {
                    change.apply(ev.data.field.get(0), [true]);
                }
                return false;
            },
            upIncrement = function(ev){
                change.apply(ev.data.field.get(0), [true]);
                ev.data.el.removeClass('colpick_slider').find('input').focus();
                $(document).off('mouseup', upIncrement);
                $(document).off('mousemove', moveIncrement);
                return false;
            },
            //Hue mcxslider functions
            downHue = function(ev){
                ev.preventDefault? ev.preventDefault() : ev.returnValue = false;
                var current = {
                    cal: $(this).parent(),
                    y  : $(this).offset().top
                };
                current.preview = current.cal.data('colpick').livePreview;
                $(document).mouseup(current, upHue);
                $(document).mousemove(current, moveHue);

                change.apply(
                    current.cal.data('colpick')
                        .fields.eq(4).val(parseInt(360 * (current.cal.data('colpick').height - (ev.pageY - current.y)) / current.cal.data('colpick').height, 10))
                        .get(0),
                    [current.preview]
                );
            },
            moveHue = function(ev){
                change.apply(
                    ev.data.cal.data('colpick')
                        .fields.eq(4).val(parseInt(360 * (ev.data.cal.data('colpick').height - Math.max(0, Math.min(ev.data.cal.data('colpick').height, (ev.pageY - ev.data.y)))) / ev.data.cal.data('colpick').height, 10))
                        .get(0),
                    [ev.data.preview]
                );
                return false;
            },
            upHue = function(ev){
                fillRGBFields(ev.data.cal.data('colpick').color, ev.data.cal.get(0));
                fillHexFields(ev.data.cal.data('colpick').color, ev.data.cal.get(0));
                $(document).off('mouseup', upHue);
                $(document).off('mousemove', moveHue);
                return false;
            },
            //Color selector functions
            downSelector = function(ev){
                ev.preventDefault? ev.preventDefault() : ev.returnValue = false;
                var current = {
                    cal: $(this).parent(),
                    pos: $(this).offset()
                };
                current.preview = current.cal.data('colpick').livePreview;

                $(document).mouseup(current, upSelector);
                $(document).mousemove(current, moveSelector);

                change.apply(
                    current.cal.data('colpick').fields
                        .eq(6).val(parseInt(100 * (current.cal.data('colpick').height - (ev.pageY - current.pos.top)) / current.cal.data('colpick').height, 10)).end()
                        .eq(5).val(parseInt(100 * (ev.pageX - current.pos.left) / current.cal.data('colpick').height, 10))
                        .get(0),
                    [current.preview]
                );
            },
            moveSelector = function(ev){
                change.apply(
                    ev.data.cal.data('colpick').fields
                        .eq(6).val(parseInt(100 * (ev.data.cal.data('colpick').height - Math.max(0, Math.min(ev.data.cal.data('colpick').height, (ev.pageY - ev.data.pos.top)))) / ev.data.cal.data('colpick').height, 10)).end()
                        .eq(5).val(parseInt(100 * (Math.max(0, Math.min(ev.data.cal.data('colpick').height, (ev.pageX - ev.data.pos.left)))) / ev.data.cal.data('colpick').height, 10))
                        .get(0),
                    [ev.data.preview]
                );
                return false;
            },
            upSelector = function(ev){
                fillRGBFields(ev.data.cal.data('colpick').color, ev.data.cal.get(0));
                fillHexFields(ev.data.cal.data('colpick').color, ev.data.cal.get(0));
                $(document).off('mouseup', upSelector);
                $(document).off('mousemove', moveSelector);
                return false;
            },
            //Submit button
            clickSubmit = function(ev){
                var cal = $(this).parent();
                var col = cal.data('colpick').color;
                cal.data('colpick').origColor = col;
                setCurrentColor(col, cal.get(0));
                cal.data('colpick').onSubmit(col, hsbToHex(col), hsbToRgb(col), cal.data('colpick').el);
            },
            //Show/hide the color picker
            show = function(ev){
                var cal = $(this).find('#' + $(this).data('colpickId'));
                cal.data('colpick').onBeforeShow.apply(this, [cal.get(0)]);
                var pos = $(this).offset();
                var top = pos.top + this.offsetHeight;
                var left = pos.left;
                var viewPort = getViewport();
                if(left + 346 > viewPort.l + viewPort.w)
                {
                    left -= 346;
                }
                cal.css({left: left + 'px', top: top + 'px'});
                if(cal.data('colpick').onShow.apply(this, [cal.get(0)]) != false)
                {
                    cal.show();
                }
                //Hide when user clicks outside
                $('html').mousedown({cal: cal}, hide);
                cal.mousedown(function(ev){
                    ev.stopPropagation();
                })
            },
            hide = function(ev){
                if(ev.data.cal.data('colpick').onHide.apply(this, [ev.data.cal.get(0)]) != false)
                {
                    ev.data.cal.hide();
                }
                $('html').off('mousedown', hide);
            },
            getViewport = function(){
                var m = document.compatMode == 'CSS1Compat';
                return {
                    l: window.pageXOffset || (m? document.documentElement.scrollLeft : document.body.scrollLeft),
                    w: window.innerWidth || (m? document.documentElement.clientWidth : document.body.clientWidth)
                };
            },
            //Fix the values if the user enters a negative or high value
            fixHSB = function(hsb){
                return {
                    h: Math.min(360, Math.max(0, hsb.h)),
                    s: Math.min(100, Math.max(0, hsb.s)),
                    b: Math.min(100, Math.max(0, hsb.b))
                };
            },
            fixRGB = function(rgb){
                return {
                    r: Math.min(255, Math.max(0, rgb.r)),
                    g: Math.min(255, Math.max(0, rgb.g)),
                    b: Math.min(255, Math.max(0, rgb.b))
                };
            },
            fixHex = function(hex){
                var len = 6 - hex.length;
                if(len > 0)
                {
                    var o = [];
                    for(var i = 0 ; i < len ; i++)
                    {
                        o.push('0');
                    }
                    o.push(hex);
                    hex = o.join('');
                }
                return hex;
            },
            restoreOriginal = function(){
                var cal = $(this).parent();
                var col = cal.data('colpick').origColor;
                cal.data('colpick').color = col;
                fillRGBFields(col, cal.get(0));
                fillHexFields(col, cal.get(0));
                fillHSBFields(col, cal.get(0));
                setSelector(col, cal.get(0));
                setHue(col, cal.get(0));
                setNewColor(col, cal.get(0));
            };
        return {
            init      : function(opt){
                opt = $.extend({}, defaults, opt || {});
                //Set color
                if(typeof opt.color == 'string')
                {
                    opt.color = hexToHsb(opt.color);
                }
                else if(opt.color.r != undefined && opt.color.g != undefined && opt.color.b != undefined)
                {
                    opt.color = rgbToHsb(opt.color);
                }
                else if(opt.color.h != undefined && opt.color.s != undefined && opt.color.b != undefined)
                {
                    opt.color = fixHSB(opt.color);
                }
                else
                {
                    return this;
                }

                //For each selected DOM element
                return this.each(function(){
                    //If the element does not have an ID
                    if(!$(this).data('colpickId'))
                    {
                        var options = $.extend({}, opt);
                        options.origColor = opt.color;
                        //Generate and assign a random ID
                        var id = 'collorpicker_' + parseInt(Math.random() * 1000);
                        $(this).data('colpickId', id);
                        //Set the tpl's ID and get the HTML
                        var cal = $(tpl).attr('id', id);
                        //Add class according to mcxmcxlayout
                        cal.addClass('colpick_' + options.mcxmcxlayout + (options.submit? '' : ' colpick_' + options.mcxlayout + '_ns'));
                        //Add class if the color scheme is not default
                        if(options.colorScheme != 'light')
                        {
                            cal.addClass('colpick_' + options.colorScheme);
                        }
                        //Setup submit button
                        cal.find('div.colpick_submit').html(options.submitText).click(clickSubmit);
                        //Setup input fields
                        options.fields = cal.find('input').change(change).blur(blur).focus(focus);
                        cal.find('div.colpick_field_arrs').mousedown(downIncrement).end().find('div.colpick_current_color').click(restoreOriginal);
                        //Setup hue selector
                        options.selector = cal.find('div.colpick_color').mousedown(downSelector);
                        options.selectorIndic = options.selector.find('div.colpick_selector_outer');
                        //Store parts of the plugin
                        options.el = this;
                        options.hue = cal.find('div.colpick_hue_arrs');
                        var huebar = options.hue.parent();
                        //Paint the hue bar
                        var UA = navigator.userAgent.toLowerCase();
                        var isIE = navigator.appName === 'Microsoft Internet Explorer';
                        var IEver = isIE? parseFloat(UA.match(/msie ([0-9]{1,}[\.0-9]{0,})/)[1]) : 0;
                        var ngIE = (isIE && IEver < 10);
                        var stops = ['#ff0000', '#ff0080', '#ff00ff', '#8000ff', '#0000ff', '#0080ff', '#00ffff', '#00ff80', '#00ff00', '#80ff00', '#ffff00', '#ff8000', '#ff0000'];
                        if(ngIE)
                        {
                            var i, div;
                            for(i = 0 ; i <= 11 ; i++)
                            {
                                div = $('<div></div>').attr('style', 'height:8.333333%; filter:progid:DXImageTransform.Microsoft.gradient(GradientType=0,startColorstr=' + stops[i] + ', endColorstr=' + stops[i + 1] + '); -ms-filter: "progid:DXImageTransform.Microsoft.gradient(GradientType=0,startColorstr=' + stops[i] + ', endColorstr=' + stops[i + 1] + ')";');
                                huebar.append(div);
                            }
                        }
                        if($.browser.msie)
                        {
                            var stopList = stops.join(',');
                            huebar.attr('style', 'background:-ms-linear-gradient(top center,' + stopList + '); background:-ms-linear-gradient(top center,' + stopList + '); background:linear-gradient(to bottom,' + stopList + '); ');
                            huebar.css({'background': 'linear-gradient(to bottom,' + stopList + ')'});
                            huebar.css({'background': '-ms-linear-gradient(top,' + stopList + ')'});
                        }
                        else if($.browser.webkit)
                        {
                            var stopList = stops.join(',');
                            huebar.attr('style', 'background:-webkit-linear-gradient(top center,' + stopList + '); background:-webkit-linear-gradient(top center,' + stopList + '); background:linear-gradient(to bottom,' + stopList + '); ');
                            huebar.css({'background': 'linear-gradient(to bottom,' + stopList + ')'});
                            huebar.css({'background': '-webkit-linear-gradient(top,' + stopList + ')'});
                        }
                        else
                        {
                            var stopList = stops.join(',');
                            huebar.attr('style', 'background:-webkit-linear-gradient(top center,' + stopList + '); background:-moz-linear-gradient(top center,' + stopList + '); background:linear-gradient(to bottom,' + stopList + '); ');
                            huebar.css({'background': 'linear-gradient(to bottom,' + stopList + ')'});
                            huebar.css({'background': '-moz-linear-gradient(top,' + stopList + ')'});
                        }
                        cal.find('div.colpick_hue').mousedown(downHue);
                        options.newColor = cal.find('div.colpick_new_color');
                        options.currentColor = cal.find('div.colpick_current_color');
                        //Store options and fill with default color
                        cal.data('colpick', options);
                        fillRGBFields(options.color, cal.get(0));
                        fillHSBFields(options.color, cal.get(0));
                        fillHexFields(options.color, cal.get(0));
                        setHue(options.color, cal.get(0));
                        setSelector(options.color, cal.get(0));
                        setCurrentColor(options.color, cal.get(0));
                        setNewColor(options.color, cal.get(0));
                        //Append to body if flat=false, else show in place
                        if(options.flat)
                        {
                            cal.appendTo(this).show();
                            cal.css({
                                position: 'relative',
                                display : 'block'
                            });
                        }
                        else
                        {
                            cal.appendTo(document.body);
                            $(this).on(options.showEvent, show);
                            cal.css({
                                position: 'absolute'
                            });
                        }
                    }
                });
            },
            //Shows the picker
            showPicker: function(){
                return this.each(function(){
                    if($(this).data('colpickId'))
                    {
                        show.apply(this);
                    }
                });
            },
            //Hides the picker
            hidePicker: function(){
                return this.each(function(){
                    if($(this).data('colpickId'))
                    {
                        $('#' + $(this).data('colpickId')).hide();
                    }
                });
            },
            //Sets a color as new and current (default)
            setColor  : function(col, setCurrent){
                setCurrent = (typeof setCurrent === "undefined")? 1 : setCurrent;
                if(typeof col == 'string')
                {
                    col = hexToHsb(col);
                }
                else if(col.r != undefined && col.g != undefined && col.b != undefined)
                {
                    col = rgbToHsb(col);
                }
                else if(col.h != undefined && col.s != undefined && col.b != undefined)
                {
                    col = fixHSB(col);
                }
                else
                {
                    return this;
                }
                return this.each(function(){
                    if($(this).data('colpickId'))
                    {
                        var cal = $(this).find('#' + $(this).data('colpickId'));
                        cal.data('colpick').color = col;
                        cal.data('colpick').origColor = col;
                        fillRGBFields(col, cal.get(0));
                        fillHSBFields(col, cal.get(0));
                        fillHexFields(col, cal.get(0));
                        setHue(col, cal.get(0));
                        setSelector(col, cal.get(0));

                        setNewColor(col, cal.get(0));
                        cal.data('colpick').onChange.apply(cal.parent(), [col, hsbToHex(col), hsbToRgb(col), 1]);
                        if(setCurrent)
                        {
                            setCurrentColor(col, cal.get(0));
                        }
                    }
                });
            }
        };
    }();
    //Color space convertions
    var hexToRgb = function(hex){
        var hex = parseInt(((hex.indexOf('#') > -1)? hex.substring(1) : hex), 16);
        return {r: hex >> 16, g: (hex & 0x00FF00) >> 8, b: (hex & 0x0000FF)};
    };
    var hexToHsb = function(hex){
        return rgbToHsb(hexToRgb(hex));
    };
    var rgbToHsb = function(rgb){
        var hsb = {h: 0, s: 0, b: 0};
        var min = Math.min(rgb.r, rgb.g, rgb.b);
        var max = Math.max(rgb.r, rgb.g, rgb.b);
        var delta = max - min;
        hsb.b = max;
        hsb.s = max != 0? 255 * delta / max : 0;
        if(hsb.s != 0)
        {
            if(rgb.r == max) hsb.h = (rgb.g - rgb.b) / delta;
            else if(rgb.g == max) hsb.h = 2 + (rgb.b - rgb.r) / delta;
            else hsb.h = 4 + (rgb.r - rgb.g) / delta;
        }
        else hsb.h = -1;
        hsb.h *= 60;
        if(hsb.h < 0) hsb.h += 360;
        hsb.s *= 100 / 255;
        hsb.b *= 100 / 255;
        return hsb;
    };
    var hsbToRgb = function(hsb){
        var rgb = {};
        var h = Math.round(hsb.h);
        var s = Math.round(hsb.s * 255 / 100);
        var v = Math.round(hsb.b * 255 / 100);
        if(s == 0)
        {
            rgb.r = rgb.g = rgb.b = v;
        }
        else
        {
            var t1 = v;
            var t2 = (255 - s) * v / 255;
            var t3 = (t1 - t2) * (h % 60) / 60;
            if(h == 360) h = 0;
            if(h < 60)
            {
                rgb.r = t1;
                rgb.b = t2;
                rgb.g = t2 + t3
            }
            else if(h < 120)
            {
                rgb.g = t1;
                rgb.b = t2;
                rgb.r = t1 - t3
            }
            else if(h < 180)
            {
                rgb.g = t1;
                rgb.r = t2;
                rgb.b = t2 + t3
            }
            else if(h < 240)
            {
                rgb.b = t1;
                rgb.r = t2;
                rgb.g = t1 - t3
            }
            else if(h < 300)
            {
                rgb.b = t1;
                rgb.g = t2;
                rgb.r = t2 + t3
            }
            else if(h < 360)
            {
                rgb.r = t1;
                rgb.g = t2;
                rgb.b = t1 - t3
            }
            else
            {
                rgb.r = 0;
                rgb.g = 0;
                rgb.b = 0
            }
        }
        return {r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b)};
    };
    var rgbToHex = function(rgb){
        var hex = [
            rgb.r.toString(16),
            rgb.g.toString(16),
            rgb.b.toString(16)
        ];
        $.each(hex, function(nr, val){
            if(val.length == 1)
            {
                hex[nr] = '0' + val;
            }
        });
        return hex.join('');
    };
    var hsbToHex = function(hsb){
        return rgbToHex(hsbToRgb(hsb));
    };

//	$.fn.extend({
//		colpick: colpick.init,
//		colpickHide: colpick.hidePicker,
//		colpickShow: colpick.showPicker,
//		colpickSetColor: colpick.setColor
//	});

    $.fn.colpick = colpick.init;
    $.fn.colpickHide = colpick.hidePicker;
    $.fn.colpickShow = colpick.showPicker;
    $.fn.colpickSetColor = colpick.setColor;

    $.colpickRgbToHex = rgbToHex;
    $.colpickRgbToHsb = rgbToHsb;
    $.colpickHsbToHex = hsbToHex;
    $.colpickHsbToRgb = hsbToRgb;
    $.colpickHexToHsb = hexToHsb;
    $.colpickHexToRgb = hexToRgb;

//	$.extend({
//		colpickRgbToHex: rgbToHex,
//		colpickRgbToHsb: rgbToHsb,
//		colpickHsbToHex: hsbToHex,
//		colpickHsbToRgb: hsbToRgb,
//		colpickHexToHsb: hexToHsb,
//		colpickHexToRgb: hexToRgb
//	});
})(jQuery)

// proj4

var Proj4js = {
    defaultDatum     : "WGS84",
    transform        : function(a, c, b){
        if(!a.readyToUse) return this.reportError("Proj4js initialization for:" + a.srsCode + " not yet complete"), b;
        if(!c.readyToUse) return this.reportError("Proj4js initialization for:" + c.srsCode + " not yet complete"), b;
        if(a.datum && c.datum && ((a.datum.datum_type == Proj4js.common.PJD_3PARAM || a.datum.datum_type == Proj4js.common.PJD_7PARAM) && "WGS84" != c.datumCode || (c.datum.datum_type == Proj4js.common.PJD_3PARAM || c.datum.datum_type == Proj4js.common.PJD_7PARAM) &&
                "WGS84" != a.datumCode))
        {
            var d = Proj4js.WGS84;
            this.transform(a, d, b);
            a = d
        }
        "enu" != a.axis && this.adjust_axis(a, !1, b);
        "longlat" == a.projName? (b.x *= Proj4js.common.D2R, b.y *= Proj4js.common.D2R) : (a.to_meter && (b.x *= a.to_meter, b.y *= a.to_meter), a.inverse(b));
        a.from_greenwich && (b.x += a.from_greenwich);
        b = this.datum_transform(a.datum, c.datum, b);
        c.from_greenwich && (b.x -= c.from_greenwich);
        "longlat" == c.projName? (b.x *= Proj4js.common.R2D, b.y *= Proj4js.common.R2D) : (c.forward(b), c.to_meter && (b.x /= c.to_meter, b.y /= c.to_meter));
        "enu" != c.axis && this.adjust_axis(c, !0, b);
        return b
    },
    datum_transform  : function(a, c, b){
        if(a.compare_datums(c) || a.datum_type == Proj4js.common.PJD_NODATUM || c.datum_type == Proj4js.common.PJD_NODATUM) return b;
        if(a.es != c.es || a.a != c.a || a.datum_type == Proj4js.common.PJD_3PARAM || a.datum_type == Proj4js.common.PJD_7PARAM || c.datum_type == Proj4js.common.PJD_3PARAM || c.datum_type == Proj4js.common.PJD_7PARAM) a.geodetic_to_geocentric(b), (a.datum_type == Proj4js.common.PJD_3PARAM || a.datum_type == Proj4js.common.PJD_7PARAM) && a.geocentric_to_wgs84(b),
        (c.datum_type == Proj4js.common.PJD_3PARAM || c.datum_type == Proj4js.common.PJD_7PARAM) && c.geocentric_from_wgs84(b), c.geocentric_to_geodetic(b);
        return b
    },
    adjust_axis      : function(a, c, b){
        for(var d = b.x, e = b.y, f = b.z || 0, g, i, h = 0 ; 3 > h ; h++) if(!c || !(2 == h && void 0 === b.z)) switch(0 == h? (g = d, i = "x") : 1 == h? (g = e, i = "y") : (g = f, i = "z"), a.axis[h])
        {
            case "e":
                b[i] = g;
                break;
            case "w":
                b[i] = -g;
                break;
            case "n":
                b[i] = g;
                break;
            case "s":
                b[i] = -g;
                break;
            case "u":
                void 0 !== b[i] && (b.z = g);
                break;
            case "d":
                void 0 !== b[i] && (b.z = -g);
                break;
            default:
                return alert("ERROR: unknow axis (" +
                    a.axis[h] + ") - check definition of " + a.projName), null
        }
        return b
    },
    reportError      : function(){
    },
    extend           : function(a, c){
        a = a || {};
        if(c) for(var b in c)
        {
            var d = c[b];
            void 0 !== d && (a[b] = d)
        }
        return a
    },
    Class            : function(){
        for(var a = function(){
            this.initialize.apply(this, arguments)
        }, c = {}, b, d = 0 ; d < arguments.length ; ++d) b = "function" == typeof arguments[d]? arguments[d].prototype : arguments[d], Proj4js.extend(c, b);
        a.prototype = c;
        return a
    },
    bind             : function(a, c){
        var b = Array.prototype.slice.apply(arguments, [2]);
        return function(){
            var d = b.concat(Array.prototype.slice.apply(arguments,
                [0]));
            return a.apply(c, d)
        }
    },
    scriptName       : "proj4js-compressed.js",
    defsLookupService: "http://spatialreference.org/ref",
    libPath          : null,
    getScriptLocation: function(){
        if(this.libPath) return this.libPath;
        for(var a = this.scriptName, c = a.length, b = document.getElementsByTagName("script"), d = 0 ; d < b.length ; d++)
        {
            var e = b[d].getAttribute("src");
            if(e)
            {
                var f = e.lastIndexOf(a);
                if(-1 < f && f + c == e.length)
                {
                    this.libPath = e.slice(0, -c);
                    break
                }
            }
        }
        return this.libPath || ""
    },
    loadScript       : function(a, c, b, d){
        var e = document.createElement("script");
        e.defer = !1;
        e.type = "text/javascript";
        e.id = a;
        e.src = a;
        e.onload = c;
        e.onerror = b;
        e.loadCheck = d;
        /MSIE/.test(navigator.userAgent) && (e.onreadystatechange = this.checkReadyState);
        document.getElementsByTagName("head")[0].appendChild(e)
    },
    checkReadyState  : function(){
        if("loaded" == this.readyState) if(this.loadCheck()) this.onload();
        else this.onerror()
    }
};
Proj4js.Proj = Proj4js.Class({
    readyToUse         : !1,
    title              : null,
    projName           : null,
    units              : null,
    datum              : null,
    x0                 : 0,
    y0                 : 0,
    localCS            : !1,
    queue              : null,
    initialize         : function(a, c){
        this.srsCodeInput = a;
        this.queue = [];
        c && this.queue.push(c);
        if(0 <= a.indexOf("GEOGCS") || 0 <= a.indexOf("GEOCCS") || 0 <= a.indexOf("PROJCS") || 0 <= a.indexOf("LOCAL_CS")) this.parseWKT(a), this.deriveConstants(), this.loadProjCode(this.projName);
        else
        {
            if(0 == a.indexOf("urn:"))
            {
                var b = a.split(":");
                if(("ogc" == b[1] || "x-ogc" == b[1]) && "def" == b[2] && "crs" == b[3]) a = b[4] + ":" + b[b.length -
                1]
            }
            else 0 == a.indexOf("http://") && (b = a.split("#"), b[0].match(/epsg.org/)? a = "EPSG:" + b[1] : b[0].match(/RIG.xml/) && (a = "IGNF:" + b[1]));
            this.srsCode = a.toUpperCase();
            0 == this.srsCode.indexOf("EPSG")? (this.srsCode = this.srsCode, this.srsAuth = "epsg", this.srsProjNumber = this.srsCode.substring(5)) : 0 == this.srsCode.indexOf("IGNF")? (this.srsCode = this.srsCode, this.srsAuth = "IGNF", this.srsProjNumber = this.srsCode.substring(5)) : 0 == this.srsCode.indexOf("CRS")? (this.srsCode = this.srsCode, this.srsAuth = "CRS", this.srsProjNumber =
                this.srsCode.substring(4)) : (this.srsAuth = "", this.srsProjNumber = this.srsCode);
            this.loadProjDefinition()
        }
    },
    loadProjDefinition : function(){
        if(Proj4js.defs[this.srsCode]) this.defsLoaded();
        else
        {
            var a = Proj4js.getScriptLocation() + "defs/" + this.srsAuth.toUpperCase() + this.srsProjNumber + ".js";
            Proj4js.loadScript(a, Proj4js.bind(this.defsLoaded, this), Proj4js.bind(this.loadFromService, this), Proj4js.bind(this.checkDefsLoaded, this))
        }
    },
    loadFromService    : function(){
        Proj4js.loadScript(Proj4js.defsLookupService + "/" + this.srsAuth +
            "/" + this.srsProjNumber + "/proj4js/", Proj4js.bind(this.defsLoaded, this), Proj4js.bind(this.defsFailed, this), Proj4js.bind(this.checkDefsLoaded, this))
    },
    defsLoaded         : function(){
        this.parseDefs();
        this.loadProjCode(this.projName)
    },
    checkDefsLoaded    : function(){
        return Proj4js.defs[this.srsCode]? !0 : !1
    },
    defsFailed         : function(){
        Proj4js.reportError("failed to load projection definition for: " + this.srsCode);
        Proj4js.defs[this.srsCode] = Proj4js.defs.WGS84;
        this.defsLoaded()
    },
    loadProjCode       : function(a){
        if(Proj4js.Proj[a]) this.initTransforms();
        else
        {
            var c = Proj4js.getScriptLocation() + "projCode/" + a + ".js";
            Proj4js.loadScript(c, Proj4js.bind(this.loadProjCodeSuccess, this, a), Proj4js.bind(this.loadProjCodeFailure, this, a), Proj4js.bind(this.checkCodeLoaded, this, a))
        }
    },
    loadProjCodeSuccess: function(a){
        Proj4js.Proj[a].dependsOn? this.loadProjCode(Proj4js.Proj[a].dependsOn) : this.initTransforms()
    },
    loadProjCodeFailure: function(a){
        Proj4js.reportError("failed to find projection file for: " + a)
    },
    checkCodeLoaded    : function(a){
        return Proj4js.Proj[a]? !0 : !1
    },
    initTransforms     : function(){
        Proj4js.extend(this,
            Proj4js.Proj[this.projName]);
        this.init();
        this.readyToUse = !0;
        if(this.queue) for(var a ; a = this.queue.shift() ;) a.call(this, this)
    },
    wktRE              : /^(\w+)\[(.*)\]$/,
    parseWKT           : function(a){
        if(a = a.match(this.wktRE))
        {
            var c = a[1], b = a[2].split(","), d;
            d = "TOWGS84" == c.toUpperCase()? c : b.shift();
            d = d.replace(/^\"/, "");
            d = d.replace(/\"$/, "");
            for(var a = [], e = 0, f = "", g = 0 ; g < b.length ; ++g)
            {
                for(var i = b[g], h = 0 ; h < i.length ; ++h) "[" == i.charAt(h) && ++e, "]" == i.charAt(h) && --e;
                f += i;
                0 === e? (a.push(f), f = "") : f += ","
            }
            switch(c)
            {
                case "LOCAL_CS":
                    this.projName =
                        "identity";
                    this.localCS = !0;
                    this.srsCode = d;
                    break;
                case "GEOGCS":
                    this.projName = "longlat";
                    this.geocsCode = d;
                    this.srsCode || (this.srsCode = d);
                    break;
                case "PROJCS":
                    this.srsCode = d;
                    break;
                case "PROJECTION":
                    this.projName = Proj4js.wktProjections[d];
                    break;
                case "DATUM":
                    this.datumName = d;
                    break;
                case "LOCAL_DATUM":
                    this.datumCode = "none";
                    break;
                case "SPHEROID":
                    this.ellps = d;
                    this.a = parseFloat(a.shift());
                    this.rf = parseFloat(a.shift());
                    break;
                case "PRIMEM":
                    this.from_greenwich = parseFloat(a.shift());
                    break;
                case "UNIT":
                    this.units =
                        d;
                    this.unitsPerMeter = parseFloat(a.shift());
                    break;
                case "PARAMETER":
                    c = d.toLowerCase();
                    b = parseFloat(a.shift());
                    switch(c)
                    {
                        case "false_easting":
                            this.x0 = b;
                            break;
                        case "false_northing":
                            this.y0 = b;
                            break;
                        case "scale_factor":
                            this.k0 = b;
                            break;
                        case "central_meridian":
                            this.long0 = b * Proj4js.common.D2R;
                            break;
                        case "latitude_of_origin":
                            this.lat0 = b * Proj4js.common.D2R
                    }
                    break;
                case "TOWGS84":
                    this.datum_params = a;
                    break;
                case "AXIS":
                    c = d.toLowerCase();
                    b = a.shift();
                    switch(b)
                    {
                        case "EAST":
                            b = "e";
                            break;
                        case "WEST":
                            b = "w";
                            break;
                        case "NORTH":
                            b =
                                "n";
                            break;
                        case "SOUTH":
                            b = "s";
                            break;
                        case "UP":
                            b = "u";
                            break;
                        case "DOWN":
                            b = "d";
                            break;
                        default:
                            b = " "
                    }
                    this.axis || (this.axis = "enu");
                    switch(c)
                    {
                        case "x":
                            this.axis = b + this.axis.substr(1, 2);
                            break;
                        case "y":
                            this.axis = this.axis.substr(0, 1) + b + this.axis.substr(2, 1);
                            break;
                        case "z":
                            this.axis = this.axis.substr(0, 2) + b
                    }
            }
            for(g = 0 ; g < a.length ; ++g) this.parseWKT(a[g])
        }
    },
    parseDefs          : function(){
        this.defData = Proj4js.defs[this.srsCode];
        var a, c;
        if(this.defData)
        {
            for(var b = this.defData.split("+"), d = 0 ; d < b.length ; d++) switch(c = b[d].split("="),
                a = c[0].toLowerCase(), c = c[1], a.replace(/\s/gi, ""))
            {
                case "title":
                    this.title = c;
                    break;
                case "proj":
                    this.projName = c.replace(/\s/gi, "");
                    break;
                case "units":
                    this.units = c.replace(/\s/gi, "");
                    break;
                case "datum":
                    this.datumCode = c.replace(/\s/gi, "");
                    break;
                case "nadgrids":
                    this.nagrids = c.replace(/\s/gi, "");
                    break;
                case "ellps":
                    this.ellps = c.replace(/\s/gi, "");
                    break;
                case "a":
                    this.a = parseFloat(c);
                    break;
                case "b":
                    this.b = parseFloat(c);
                    break;
                case "rf":
                    this.rf = parseFloat(c);
                    break;
                case "lat_0":
                    this.lat0 = c * Proj4js.common.D2R;
                    break;
                case "lat_1":
                    this.lat1 = c * Proj4js.common.D2R;
                    break;
                case "lat_2":
                    this.lat2 = c * Proj4js.common.D2R;
                    break;
                case "lat_ts":
                    this.lat_ts = c * Proj4js.common.D2R;
                    break;
                case "lon_0":
                    this.long0 = c * Proj4js.common.D2R;
                    break;
                case "alpha":
                    this.alpha = parseFloat(c) * Proj4js.common.D2R;
                    break;
                case "lonc":
                    this.longc = c * Proj4js.common.D2R;
                    break;
                case "x_0":
                    this.x0 = parseFloat(c);
                    break;
                case "y_0":
                    this.y0 = parseFloat(c);
                    break;
                case "k_0":
                    this.k0 = parseFloat(c);
                    break;
                case "k":
                    this.k0 = parseFloat(c);
                    break;
                case "r_a":
                    this.R_A = !0;
                    break;
                case "zone":
                    this.zone = parseInt(c, 10);
                    break;
                case "south":
                    this.utmSouth = !0;
                    break;
                case "towgs84":
                    this.datum_params = c.split(",");
                    break;
                case "to_meter":
                    this.to_meter = parseFloat(c);
                    break;
                case "from_greenwich":
                    this.from_greenwich = c * Proj4js.common.D2R;
                    break;
                case "pm":
                    c = c.replace(/\s/gi, "");
                    this.from_greenwich = Proj4js.PrimeMeridian[c]? Proj4js.PrimeMeridian[c] : parseFloat(c);
                    this.from_greenwich *= Proj4js.common.D2R;
                    break;
                case "axis":
                    c = c.replace(/\s/gi, ""), 3 == c.length && -1 != "ewnsud".indexOf(c.substr(0, 1)) && -1 !=
                    "ewnsud".indexOf(c.substr(1, 1)) && -1 != "ewnsud".indexOf(c.substr(2, 1)) && (this.axis = c)
            }
            this.deriveConstants()
        }
    },
    deriveConstants    : function(){
        "@null" == this.nagrids && (this.datumCode = "none");
        if(this.datumCode && "none" != this.datumCode)
        {
            var a = Proj4js.Datum[this.datumCode];
            a && (this.datum_params = a.towgs84? a.towgs84.split(",") : null, this.ellps = a.ellipse, this.datumName = a.datumName? a.datumName : this.datumCode)
        }
        this.a || Proj4js.extend(this, Proj4js.Ellipsoid[this.ellps]? Proj4js.Ellipsoid[this.ellps] : Proj4js.Ellipsoid.WGS84);
        this.rf && !this.b && (this.b = (1 - 1 / this.rf) * this.a);
        if(0 === this.rf || Math.abs(this.a - this.b) < Proj4js.common.EPSLN) this.sphere = !0, this.b = this.a;
        this.a2 = this.a * this.a;
        this.b2 = this.b * this.b;
        this.es = (this.a2 - this.b2) / this.a2;
        this.e = Math.sqrt(this.es);
        this.R_A && (this.a *= 1 - this.es * (Proj4js.common.SIXTH + this.es * (Proj4js.common.RA4 + this.es * Proj4js.common.RA6)), this.a2 = this.a * this.a, this.b2 = this.b * this.b, this.es = 0);
        this.ep2 = (this.a2 - this.b2) / this.b2;
        this.k0 || (this.k0 = 1);
        this.axis || (this.axis = "enu");
        this.datum =
            new Proj4js.datum(this)
    }
});
Proj4js.Proj.longlat = {
    init      : function(){
    }, forward: function(a){
        return a
    }, inverse: function(a){
        return a
    }
};
Proj4js.Proj.identity = Proj4js.Proj.longlat;
Proj4js.defs = {
    WGS84      : "+title=long/lat:WGS84 +proj=longlat +ellps=WGS84 +datum=WGS84 +units=degrees",
    "EPSG:4326": "+title=long/lat:WGS84 +proj=longlat +a=6378137.0 +b=6356752.31424518 +ellps=WGS84 +datum=WGS84 +units=degrees",
    "EPSG:4269": "+title=long/lat:NAD83 +proj=longlat +a=6378137.0 +b=6356752.31414036 +ellps=GRS80 +datum=NAD83 +units=degrees",
    "EPSG:3875": "+title= Google Mercator +proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +no_defs"
};
Proj4js.defs["EPSG:3785"] = Proj4js.defs["EPSG:3875"];
Proj4js.defs.GOOGLE = Proj4js.defs["EPSG:3875"];
Proj4js.defs["EPSG:900913"] = Proj4js.defs["EPSG:3875"];
Proj4js.defs["EPSG:102113"] = Proj4js.defs["EPSG:3875"];
Proj4js.common = {
    PI                 : 3.141592653589793,
    HALF_PI            : 1.5707963267948966,
    TWO_PI             : 6.283185307179586,
    FORTPI             : 0.7853981633974483,
    R2D                : 57.29577951308232,
    D2R                : 0.017453292519943295,
    SEC_TO_RAD         : 4.84813681109536E-6,
    EPSLN              : 1.0E-10,
    MAX_ITER           : 20,
    COS_67P5           : 0.3826834323650898,
    AD_C               : 1.0026,
    PJD_UNKNOWN        : 0,
    PJD_3PARAM         : 1,
    PJD_7PARAM         : 2,
    PJD_GRIDSHIFT      : 3,
    PJD_WGS84          : 4,
    PJD_NODATUM        : 5,
    SRS_WGS84_SEMIMAJOR: 6378137,
    SIXTH              : 0.16666666666666666,
    RA4                : 0.04722222222222222,
    RA6                : 0.022156084656084655,
    RV4                : 0.06944444444444445,
    RV6                : 0.04243827160493827,
    msfnz              : function(a,
        c, b){
        a *= c;
        return b / Math.sqrt(1 - a * a)
    },
    tsfnz              : function(a, c, b){
        b *= a;
        b = Math.pow((1 - b) / (1 + b), 0.5 * a);
        return Math.tan(0.5 * (this.HALF_PI - c)) / b
    },
    phi2z              : function(a, c){
        for(var b = 0.5 * a, d, e = this.HALF_PI - 2 * Math.atan(c), f = 0 ; 15 >= f ; f++) if(d = a * Math.sin(e), d = this.HALF_PI - 2 * Math.atan(c * Math.pow((1 - d) / (1 + d), b)) - e, e += d, 1.0E-10 >= Math.abs(d)) return e;
        alert("phi2z has NoConvergence");
        return -9999
    },
    qsfnz              : function(a, c){
        var b;
        return 1.0E-7 < a? (b = a * c, (1 - a * a) * (c / (1 - b * b) - 0.5 / a * Math.log((1 - b) / (1 + b)))) : 2 * c
    },
    asinz              : function(a){
        1 < Math.abs(a) &&
        (a = 1 < a? 1 : -1);
        return Math.asin(a)
    },
    e0fn               : function(a){
        return 1 - 0.25 * a * (1 + a / 16 * (3 + 1.25 * a))
    },
    e1fn               : function(a){
        return 0.375 * a * (1 + 0.25 * a * (1 + 0.46875 * a))
    },
    e2fn               : function(a){
        return 0.05859375 * a * a * (1 + 0.75 * a)
    },
    e3fn               : function(a){
        return a * a * a * (35 / 3072)
    },
    mlfn               : function(a, c, b, d, e){
        return a * e - c * Math.sin(2 * e) + b * Math.sin(4 * e) - d * Math.sin(6 * e)
    },
    srat               : function(a, c){
        return Math.pow((1 - a) / (1 + a), c)
    },
    sign               : function(a){
        return 0 > a? -1 : 1
    },
    adjust_lon         : function(a){
        return a = Math.abs(a) < this.PI? a : a - this.sign(a) * this.TWO_PI
    },
    adjust_lat         : function(a){
        return a =
            Math.abs(a) < this.HALF_PI? a : a - this.sign(a) * this.PI
    },
    latiso             : function(a, c, b){
        if(Math.abs(c) > this.HALF_PI) return +Number.NaN;
        if(c == this.HALF_PI) return Number.POSITIVE_INFINITY;
        if(c == -1 * this.HALF_PI) return -1 * Number.POSITIVE_INFINITY;
        b *= a;
        return Math.log(Math.tan((this.HALF_PI + c) / 2)) + a * Math.log((1 - b) / (1 + b)) / 2
    },
    fL                 : function(a, c){
        return 2 * Math.atan(a * Math.exp(c)) - this.HALF_PI
    },
    invlatiso          : function(a, c){
        var b = this.fL(1, c), d = 0, e = 0;
        do d = b, e = a * Math.sin(d), b = this.fL(Math.exp(a * Math.log((1 + e) / (1 - e)) / 2), c);while(1.0E-12 <
        Math.abs(b - d));
        return b
    },
    sinh               : function(a){
        a = Math.exp(a);
        return (a - 1 / a) / 2
    },
    cosh               : function(a){
        a = Math.exp(a);
        return (a + 1 / a) / 2
    },
    tanh               : function(a){
        a = Math.exp(a);
        return (a - 1 / a) / (a + 1 / a)
    },
    asinh              : function(a){
        return (0 <= a? 1 : -1) * Math.log(Math.abs(a) + Math.sqrt(a * a + 1))
    },
    acosh              : function(a){
        return 2 * Math.log(Math.sqrt((a + 1) / 2) + Math.sqrt((a - 1) / 2))
    },
    atanh              : function(a){
        return Math.log((a - 1) / (a + 1)) / 2
    },
    gN                 : function(a, c, b){
        c *= b;
        return a / Math.sqrt(1 - c * c)
    },
    pj_enfn            : function(a){
        var c = [];
        c[0] = this.C00 - a * (this.C02 + a * (this.C04 + a * (this.C06 +
            a * this.C08)));
        c[1] = a * (this.C22 - a * (this.C04 + a * (this.C06 + a * this.C08)));
        var b = a * a;
        c[2] = b * (this.C44 - a * (this.C46 + a * this.C48));
        b *= a;
        c[3] = b * (this.C66 - a * this.C68);
        c[4] = b * a * this.C88;
        return c
    },
    pj_mlfn            : function(a, c, b, d){
        b *= c;
        c *= c;
        return d[0] * a - b * (d[1] + c * (d[2] + c * (d[3] + c * d[4])))
    },
    pj_inv_mlfn        : function(a, c, b){
        for(var d = 1 / (1 - c), e = a, f = Proj4js.common.MAX_ITER ; f ; --f)
        {
            var g = Math.sin(e), i = 1 - c * g * g, i = (this.pj_mlfn(e, g, Math.cos(e), b) - a) * i * Math.sqrt(i) * d,
                e = e - i;
            if(Math.abs(i) < Proj4js.common.EPSLN) return e
        }
        Proj4js.reportError("cass:pj_inv_mlfn: Convergence error");
        return e
    },
    C00                : 1,
    C02                : 0.25,
    C04                : 0.046875,
    C06                : 0.01953125,
    C08                : 0.01068115234375,
    C22                : 0.75,
    C44                : 0.46875,
    C46                : 0.013020833333333334,
    C48                : 0.007120768229166667,
    C66                : 0.3645833333333333,
    C68                : 0.005696614583333333,
    C88                : 0.3076171875
};
Proj4js.datum = Proj4js.Class({
    initialize                       : function(a){
        this.datum_type = Proj4js.common.PJD_WGS84;
        a.datumCode && "none" == a.datumCode && (this.datum_type = Proj4js.common.PJD_NODATUM);
        if(a && a.datum_params)
        {
            for(var c = 0 ; c < a.datum_params.length ; c++) a.datum_params[c] = parseFloat(a.datum_params[c]);
            if(0 != a.datum_params[0] || 0 != a.datum_params[1] || 0 != a.datum_params[2]) this.datum_type = Proj4js.common.PJD_3PARAM;
            if(3 < a.datum_params.length && (0 != a.datum_params[3] || 0 != a.datum_params[4] || 0 != a.datum_params[5] || 0 != a.datum_params[6])) this.datum_type =
                Proj4js.common.PJD_7PARAM, a.datum_params[3] *= Proj4js.common.SEC_TO_RAD, a.datum_params[4] *= Proj4js.common.SEC_TO_RAD, a.datum_params[5] *= Proj4js.common.SEC_TO_RAD, a.datum_params[6] = a.datum_params[6] / 1E6 + 1
        }
        a && (this.a = a.a, this.b = a.b, this.es = a.es, this.ep2 = a.ep2, this.datum_params = a.datum_params)
    }, compare_datums                : function(a){
        return this.datum_type != a.datum_type || this.a != a.a || 5.0E-11 < Math.abs(this.es - a.es)? !1 : this.datum_type == Proj4js.common.PJD_3PARAM? this.datum_params[0] == a.datum_params[0] && this.datum_params[1] ==
            a.datum_params[1] && this.datum_params[2] == a.datum_params[2] : this.datum_type == Proj4js.common.PJD_7PARAM? this.datum_params[0] == a.datum_params[0] && this.datum_params[1] == a.datum_params[1] && this.datum_params[2] == a.datum_params[2] && this.datum_params[3] == a.datum_params[3] && this.datum_params[4] == a.datum_params[4] && this.datum_params[5] == a.datum_params[5] && this.datum_params[6] == a.datum_params[6] : this.datum_type == Proj4js.common.PJD_GRIDSHIFT || a.datum_type == Proj4js.common.PJD_GRIDSHIFT? (alert("ERROR: Grid shift transformations are not implemented."),
            !1) : !0
    }, geodetic_to_geocentric        : function(a){
        var c = a.x, b = a.y, d = a.z? a.z : 0, e, f, g;
        if(b < -Proj4js.common.HALF_PI && b > -1.001 * Proj4js.common.HALF_PI) b = -Proj4js.common.HALF_PI;
        else if(b > Proj4js.common.HALF_PI && b < 1.001 * Proj4js.common.HALF_PI) b = Proj4js.common.HALF_PI;
        else if(b < -Proj4js.common.HALF_PI || b > Proj4js.common.HALF_PI) return Proj4js.reportError("geocent:lat out of range:" + b), null;
        c > Proj4js.common.PI && (c -= 2 * Proj4js.common.PI);
        f = Math.sin(b);
        g = Math.cos(b);
        e = this.a / Math.sqrt(1 - this.es * f * f);
        b = (e + d) * g * Math.cos(c);
        c = (e + d) * g * Math.sin(c);
        d = (e * (1 - this.es) + d) * f;
        a.x = b;
        a.y = c;
        a.z = d;
        return 0
    }, geocentric_to_geodetic        : function(a){
        var c, b, d, e, f, g, i, h, j, k, l = a.x;
        d = a.y;
        var m = a.z? a.z : 0;
        c = Math.sqrt(l * l + d * d);
        b = Math.sqrt(l * l + d * d + m * m);
        if(1.0E-12 > c / this.a)
        {
            if(l = 0, 1.0E-12 > b / this.a) return
        }
        else l = Math.atan2(d, l);
        d = m / b;
        e = c / b;
        f = 1 / Math.sqrt(1 - this.es * (2 - this.es) * e * e);
        i = e * (1 - this.es) * f;
        h = d * f;
        k = 0;
        do k++, g = this.a / Math.sqrt(1 - this.es * h * h), b = c * i + m * h - g * (1 - this.es * h * h), g = this.es * g / (g + b), f = 1 / Math.sqrt(1 - g * (2 - g) * e * e), g = e * (1 - g) * f, f *= d, j = f * i - g *
            h, i = g, h = f;while(1.0E-24 < j * j && 30 > k);
        c = Math.atan(f / Math.abs(g));
        a.x = l;
        a.y = c;
        a.z = b;
        return a
    }, geocentric_to_geodetic_noniter: function(a){
        var c = a.x, b = a.y, d = a.z? a.z : 0, e, f, g, i, h, c = parseFloat(c), b = parseFloat(b), d = parseFloat(d);
        h = !1;
        if(0 != c) e = Math.atan2(b, c);
        else if(0 < b) e = Proj4js.common.HALF_PI;
        else if(0 > b) e = -Proj4js.common.HALF_PI;
        else if(h = !0, e = 0, 0 < d) f = Proj4js.common.HALF_PI;
        else if(0 > d) f = -Proj4js.common.HALF_PI;
        else return;
        g = c * c + b * b;
        c = Math.sqrt(g);
        b = d * Proj4js.common.AD_C;
        g = Math.sqrt(b * b + g);
        b /= g;
        g = c / g;
        b =
            d + this.b * this.ep2 * b * b * b;
        i = c - this.a * this.es * g * g * g;
        g = Math.sqrt(b * b + i * i);
        b /= g;
        g = i / g;
        i = this.a / Math.sqrt(1 - this.es * b * b);
        d = g >= Proj4js.common.COS_67P5? c / g - i : g <= -Proj4js.common.COS_67P5? c / -g - i : d / b + i * (this.es - 1);
        !1 == h && (f = Math.atan(b / g));
        a.x = e;
        a.y = f;
        a.z = d;
        return a
    }, geocentric_to_wgs84           : function(a){
        if(this.datum_type == Proj4js.common.PJD_3PARAM) a.x += this.datum_params[0], a.y += this.datum_params[1], a.z += this.datum_params[2];
        else if(this.datum_type == Proj4js.common.PJD_7PARAM)
        {
            var c = this.datum_params[3], b = this.datum_params[4],
                d = this.datum_params[5], e = this.datum_params[6],
                f = e * (d * a.x + a.y - c * a.z) + this.datum_params[1],
                c = e * (-b * a.x + c * a.y + a.z) + this.datum_params[2];
            a.x = e * (a.x - d * a.y + b * a.z) + this.datum_params[0];
            a.y = f;
            a.z = c
        }
    }, geocentric_from_wgs84         : function(a){
        if(this.datum_type == Proj4js.common.PJD_3PARAM) a.x -= this.datum_params[0], a.y -= this.datum_params[1], a.z -= this.datum_params[2];
        else if(this.datum_type == Proj4js.common.PJD_7PARAM)
        {
            var c = this.datum_params[3], b = this.datum_params[4], d = this.datum_params[5], e = this.datum_params[6],
                f = (a.x -
                    this.datum_params[0]) / e, g = (a.y - this.datum_params[1]) / e,
                e = (a.z - this.datum_params[2]) / e;
            a.x = f + d * g - b * e;
            a.y = -d * f + g + c * e;
            a.z = b * f - c * g + e
        }
    }
});
Proj4js.Point = Proj4js.Class({
    initialize      : function(a, c, b){
        "object" == typeof a? (this.x = a[0], this.y = a[1], this.z = a[2] || 0) : "string" == typeof a && "undefined" == typeof c? (a = a.split(","), this.x = parseFloat(a[0]), this.y = parseFloat(a[1]), this.z = parseFloat(a[2]) || 0) : (this.x = a, this.y = c, this.z = b || 0)
    }, clone        : function(){
        return new Proj4js.Point(this.x, this.y, this.z)
    }, toString     : function(){
        return "x=" + this.x + ",y=" + this.y
    }, toShortString: function(){
        return this.x + ", " + this.y
    }
});
Proj4js.PrimeMeridian = {
    greenwich: 0,
    lisbon   : -9.131906111111,
    paris    : 2.337229166667,
    bogota   : -74.080916666667,
    madrid   : -3.687938888889,
    rome     : 12.452333333333,
    bern     : 7.439583333333,
    jakarta  : 106.807719444444,
    ferro    : -17.666666666667,
    brussels : 4.367975,
    stockholm: 18.058277777778,
    athens   : 23.7163375,
    oslo     : 10.722916666667
};
Proj4js.Ellipsoid = {
    MERIT   : {a: 6378137, rf: 298.257, ellipseName: "MERIT 1983"},
    SGS85   : {a: 6378136, rf: 298.257, ellipseName: "Soviet Geodetic System 85"},
    GRS80   : {a: 6378137, rf: 298.257222101, ellipseName: "GRS 1980(IUGG, 1980)"},
    IAU76   : {a: 6378140, rf: 298.257, ellipseName: "IAU 1976"},
    airy    : {a: 6377563.396, b: 6356256.91, ellipseName: "Airy 1830"},
    "APL4." : {a: 6378137, rf: 298.25, ellipseName: "Appl. Physics. 1965"},
    NWL9D   : {a: 6378145, rf: 298.25, ellipseName: "Naval Weapons Lab., 1965"},
    mod_airy: {a: 6377340.189, b: 6356034.446, ellipseName: "Modified Airy"},
    andrae  : {a: 6377104.43, rf: 300, ellipseName: "Andrae 1876 (Den., Iclnd.)"},
    aust_SA : {a: 6378160, rf: 298.25, ellipseName: "Australian Natl & S. Amer. 1969"},
    GRS67   : {a: 6378160, rf: 298.247167427, ellipseName: "GRS 67(IUGG 1967)"},
    bessel  : {a: 6377397.155, rf: 299.1528128, ellipseName: "Bessel 1841"},
    bess_nam: {a: 6377483.865, rf: 299.1528128, ellipseName: "Bessel 1841 (Namibia)"},
    clrk66  : {a: 6378206.4, b: 6356583.8, ellipseName: "Clarke 1866"},
    clrk80  : {a: 6378249.145, rf: 293.4663, ellipseName: "Clarke 1880 mod."},
    CPM     : {
        a          : 6375738.7, rf: 334.29,
        ellipseName: "Comm. des Poids et Mesures 1799"
    },
    delmbr  : {a: 6376428, rf: 311.5, ellipseName: "Delambre 1810 (Belgium)"},
    engelis : {a: 6378136.05, rf: 298.2566, ellipseName: "Engelis 1985"},
    evrst30 : {a: 6377276.345, rf: 300.8017, ellipseName: "Everest 1830"},
    evrst48 : {a: 6377304.063, rf: 300.8017, ellipseName: "Everest 1948"},
    evrst56 : {a: 6377301.243, rf: 300.8017, ellipseName: "Everest 1956"},
    evrst69 : {a: 6377295.664, rf: 300.8017, ellipseName: "Everest 1969"},
    evrstSS : {a: 6377298.556, rf: 300.8017, ellipseName: "Everest (Sabah & Sarawak)"},
    fschr60 : {a: 6378166, rf: 298.3, ellipseName: "Fischer (Mercury Datum) 1960"},
    fschr60m: {a: 6378155, rf: 298.3, ellipseName: "Fischer 1960"},
    fschr68 : {a: 6378150, rf: 298.3, ellipseName: "Fischer 1968"},
    helmert : {a: 6378200, rf: 298.3, ellipseName: "Helmert 1906"},
    hough   : {a: 6378270, rf: 297, ellipseName: "Hough"},
    intl    : {a: 6378388, rf: 297, ellipseName: "International 1909 (Hayford)"},
    kaula   : {a: 6378163, rf: 298.24, ellipseName: "Kaula 1961"},
    lerch   : {a: 6378139, rf: 298.257, ellipseName: "Lerch 1979"},
    mprts   : {a: 6397300, rf: 191, ellipseName: "Maupertius 1738"},
    new_intl: {a: 6378157.5, b: 6356772.2, ellipseName: "New International 1967"},
    plessis : {a: 6376523, rf: 6355863, ellipseName: "Plessis 1817 (France)"},
    krass   : {a: 6378245, rf: 298.3, ellipseName: "Krassovsky, 1942"},
    SEasia  : {a: 6378155, b: 6356773.3205, ellipseName: "Southeast Asia"},
    walbeck : {a: 6376896, b: 6355834.8467, ellipseName: "Walbeck"},
    WGS60   : {a: 6378165, rf: 298.3, ellipseName: "WGS 60"},
    WGS66   : {a: 6378145, rf: 298.25, ellipseName: "WGS 66"},
    WGS72   : {a: 6378135, rf: 298.26, ellipseName: "WGS 72"},
    WGS84   : {a: 6378137, rf: 298.257223563, ellipseName: "WGS 84"},
    sphere  : {a: 6370997, b: 6370997, ellipseName: "Normal Sphere (r=6370997)"}
};
Proj4js.Datum = {
    WGS84        : {towgs84: "0,0,0", ellipse: "WGS84", datumName: "WGS84"},
    GGRS87       : {
        towgs84  : "-199.87,74.79,246.62",
        ellipse  : "GRS80",
        datumName: "Greek_Geodetic_Reference_System_1987"
    },
    NAD83        : {towgs84: "0,0,0", ellipse: "GRS80", datumName: "North_American_Datum_1983"},
    NAD27        : {
        nadgrids : "@conus,@alaska,@ntv2_0.gsb,@ntv1_can.dat",
        ellipse  : "clrk66",
        datumName: "North_American_Datum_1927"
    },
    potsdam      : {towgs84: "606.0,23.0,413.0", ellipse: "bessel", datumName: "Potsdam Rauenberg 1950 DHDN"},
    carthage     : {
        towgs84: "-263.0,6.0,431.0",
        ellipse: "clark80", datumName: "Carthage 1934 Tunisia"
    },
    hermannskogel: {towgs84: "653.0,-212.0,449.0", ellipse: "bessel", datumName: "Hermannskogel"},
    ire65        : {
        towgs84  : "482.530,-130.596,564.557,-1.042,-0.214,-0.631,8.15",
        ellipse  : "mod_airy",
        datumName: "Ireland 1965"
    },
    nzgd49       : {
        towgs84  : "59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993",
        ellipse  : "intl",
        datumName: "New Zealand Geodetic Datum 1949"
    },
    OSGB36       : {
        towgs84  : "446.448,-125.157,542.060,0.1502,0.2470,0.8421,-20.4894",
        ellipse  : "airy",
        datumName: "Airy 1830"
    }
};
Proj4js.WGS84 = new Proj4js.Proj("WGS84");
Proj4js.Datum.OSB36 = Proj4js.Datum.OSGB36;
Proj4js.wktProjections = {
    "Lambert Tangential Conformal Conic Projection": "lcc",
    Mercator                                       : "merc",
    "Popular Visualisation Pseudo Mercator"        : "merc",
    Mercator_1SP                                   : "merc",
    Transverse_Mercator                            : "tmerc",
    "Transverse Mercator"                          : "tmerc",
    "Lambert Azimuthal Equal Area"                 : "laea",
    "Universal Transverse Mercator System"         : "utm"
};
Proj4js.Proj.aea = {
    init      : function(){
        Math.abs(this.lat1 + this.lat2) < Proj4js.common.EPSLN? Proj4js.reportError("aeaInitEqualLatitudes") : (this.temp = this.b / this.a, this.es = 1 - Math.pow(this.temp, 2), this.e3 = Math.sqrt(this.es), this.sin_po = Math.sin(this.lat1), this.cos_po = Math.cos(this.lat1), this.con = this.t1 = this.sin_po, this.ms1 = Proj4js.common.msfnz(this.e3, this.sin_po, this.cos_po), this.qs1 = Proj4js.common.qsfnz(this.e3, this.sin_po, this.cos_po), this.sin_po = Math.sin(this.lat2), this.cos_po = Math.cos(this.lat2), this.t2 =
            this.sin_po, this.ms2 = Proj4js.common.msfnz(this.e3, this.sin_po, this.cos_po), this.qs2 = Proj4js.common.qsfnz(this.e3, this.sin_po, this.cos_po), this.sin_po = Math.sin(this.lat0), this.cos_po = Math.cos(this.lat0), this.t3 = this.sin_po, this.qs0 = Proj4js.common.qsfnz(this.e3, this.sin_po, this.cos_po), this.ns0 = Math.abs(this.lat1 - this.lat2) > Proj4js.common.EPSLN? (this.ms1 * this.ms1 - this.ms2 * this.ms2) / (this.qs2 - this.qs1) : this.con, this.c = this.ms1 * this.ms1 + this.ns0 * this.qs1, this.rh = this.a * Math.sqrt(this.c - this.ns0 * this.qs0) /
            this.ns0)
    }, forward: function(a){
        var c = a.x, b = a.y;
        this.sin_phi = Math.sin(b);
        this.cos_phi = Math.cos(b);
        var b = Proj4js.common.qsfnz(this.e3, this.sin_phi, this.cos_phi),
            b = this.a * Math.sqrt(this.c - this.ns0 * b) / this.ns0,
            d = this.ns0 * Proj4js.common.adjust_lon(c - this.long0), c = b * Math.sin(d) + this.x0,
            b = this.rh - b * Math.cos(d) + this.y0;
        a.x = c;
        a.y = b;
        return a
    }, inverse: function(a){
        var c, b, d;
        a.x -= this.x0;
        a.y = this.rh - a.y + this.y0;
        0 <= this.ns0? (c = Math.sqrt(a.x * a.x + a.y * a.y), b = 1) : (c = -Math.sqrt(a.x * a.x + a.y * a.y), b = -1);
        d = 0;
        0 != c && (d = Math.atan2(b *
            a.x, b * a.y));
        b = c * this.ns0 / this.a;
        c = (this.c - b * b) / this.ns0;
        1.0E-10 <= this.e3? (b = 1 - 0.5 * (1 - this.es) * Math.log((1 - this.e3) / (1 + this.e3)) / this.e3, b = 1.0E-10 < Math.abs(Math.abs(b) - Math.abs(c))? this.phi1z(this.e3, c) : 0 <= c? 0.5 * Proj4js.common.PI : -0.5 * Proj4js.common.PI) : b = this.phi1z(this.e3, c);
        d = Proj4js.common.adjust_lon(d / this.ns0 + this.long0);
        a.x = d;
        a.y = b;
        return a
    }, phi1z  : function(a, c){
        var b, d, e, f, g = Proj4js.common.asinz(0.5 * c);
        if(a < Proj4js.common.EPSLN) return g;
        for(var i = a * a, h = 1 ; 25 >= h ; h++) if(b = Math.sin(g), d = Math.cos(g),
                e = a * b, f = 1 - e * e, b = 0.5 * f * f / d * (c / (1 - i) - b / f + 0.5 / a * Math.log((1 - e) / (1 + e))), g += b, 1.0E-7 >= Math.abs(b)) return g;
        Proj4js.reportError("aea:phi1z:Convergence error");
        return null
    }
};
Proj4js.Proj.sterea = {
    dependsOn : "gauss", init: function(){
        Proj4js.Proj.gauss.init.apply(this);
        this.rc? (this.sinc0 = Math.sin(this.phic0), this.cosc0 = Math.cos(this.phic0), this.R2 = 2 * this.rc, this.title || (this.title = "Oblique Stereographic Alternative")) : Proj4js.reportError("sterea:init:E_ERROR_0")
    }, forward: function(a){
        var c, b, d, e;
        a.x = Proj4js.common.adjust_lon(a.x - this.long0);
        Proj4js.Proj.gauss.forward.apply(this, [a]);
        c = Math.sin(a.y);
        b = Math.cos(a.y);
        d = Math.cos(a.x);
        e = this.k0 * this.R2 / (1 + this.sinc0 * c + this.cosc0 *
            b * d);
        a.x = e * b * Math.sin(a.x);
        a.y = e * (this.cosc0 * c - this.sinc0 * b * d);
        a.x = this.a * a.x + this.x0;
        a.y = this.a * a.y + this.y0;
        return a
    }, inverse: function(a){
        var c, b, d, e;
        a.x = (a.x - this.x0) / this.a;
        a.y = (a.y - this.y0) / this.a;
        a.x /= this.k0;
        a.y /= this.k0;
        (e = Math.sqrt(a.x * a.x + a.y * a.y))? (d = 2 * Math.atan2(e, this.R2), c = Math.sin(d), b = Math.cos(d), d = Math.asin(b * this.sinc0 + a.y * c * this.cosc0 / e), c = Math.atan2(a.x * c, e * this.cosc0 * b - a.y * this.sinc0 * c)) : (d = this.phic0, c = 0);
        a.x = c;
        a.y = d;
        Proj4js.Proj.gauss.inverse.apply(this, [a]);
        a.x = Proj4js.common.adjust_lon(a.x +
            this.long0);
        return a
    }
};

function phi4z(a, c, b, d, e, f, g, i, h)
{
    var j, k, l, m, n, o, h = f;
    for(o = 1 ; 15 >= o ; o++) if(j = Math.sin(h), l = Math.tan(h), i = l * Math.sqrt(1 - a * j * j), k = Math.sin(2 * h), m = c * h - b * k + d * Math.sin(4 * h) - e * Math.sin(6 * h), n = c - 2 * b * Math.cos(2 * h) + 4 * d * Math.cos(4 * h) - 6 * e * Math.cos(6 * h), j = 2 * m + i * (m * m + g) - 2 * f * (i * m + 1), l = a * k * (m * m + g - 2 * f * m) / (2 * i), i = 2 * (f - m) * (i * n - 2 / k) - 2 * n, j /= l + i, h += j, 1.0E-10 >= Math.abs(j)) return h;
    Proj4js.reportError("phi4z: No convergence");
    return null
}

function e4fn(a)
{
    var c;
    c = 1 + a;
    a = 1 - a;
    return Math.sqrt(Math.pow(c, c) * Math.pow(a, a))
}

Proj4js.Proj.poly = {
    init      : function(){
        0 == this.lat0 && (this.lat0 = 90);
        this.temp = this.b / this.a;
        this.es = 1 - Math.pow(this.temp, 2);
        this.e = Math.sqrt(this.es);
        this.e0 = Proj4js.common.e0fn(this.es);
        this.e1 = Proj4js.common.e1fn(this.es);
        this.e2 = Proj4js.common.e2fn(this.es);
        this.e3 = Proj4js.common.e3fn(this.es);
        this.ml0 = Proj4js.common.mlfn(this.e0, this.e1, this.e2, this.e3, this.lat0)
    }, forward: function(a){
        var c, b, d, e, f;
        d = a.y;
        b = Proj4js.common.adjust_lon(a.x - this.long0);
        1.0E-7 >= Math.abs(d)? (f = this.x0 + this.a * b, c = this.y0 -
            this.a * this.ml0) : (c = Math.sin(d), b = Math.cos(d), d = Proj4js.common.mlfn(this.e0, this.e1, this.e2, this.e3, d), e = Proj4js.common.msfnz(this.e, c, b), b = c, f = this.x0 + this.a * e * Math.sin(b) / c, c = this.y0 + this.a * (d - this.ml0 + e * (1 - Math.cos(b)) / c));
        a.x = f;
        a.y = c;
        return a
    }, inverse: function(a){
        var c, b;
        a.x -= this.x0;
        a.y -= this.y0;
        c = this.ml0 + a.y / this.a;
        if(1.0E-7 >= Math.abs(c)) c = a.x / this.a + this.long0, b = 0;
        else
        {
            c = c * c + a.x / this.a * (a.x / this.a);
            c = phi4z(this.es, this.e0, this.e1, this.e2, this.e3, this.al, c, void 0, b);
            if(1 != c) return c;
            c = Proj4js.common.adjust_lon(Proj4js.common.asinz(NaN *
                a.x / this.a) / Math.sin(b) + this.long0)
        }
        a.x = c;
        a.y = b;
        return a
    }
};
Proj4js.Proj.equi = {
    init      : function(){
        this.x0 || (this.x0 = 0);
        this.y0 || (this.y0 = 0);
        this.lat0 || (this.lat0 = 0);
        this.long0 || (this.long0 = 0)
    }, forward: function(a){
        var c = a.y, b = this.x0 + this.a * Proj4js.common.adjust_lon(a.x - this.long0) * Math.cos(this.lat0),
            c = this.y0 + this.a * c;
        this.t1 = b;
        this.t2 = Math.cos(this.lat0);
        a.x = b;
        a.y = c;
        return a
    }, inverse: function(a){
        a.x -= this.x0;
        a.y -= this.y0;
        var c = a.y / this.a;
        Math.abs(c) > Proj4js.common.HALF_PI && Proj4js.reportError("equi:Inv:DataError");
        var b = Proj4js.common.adjust_lon(this.long0 +
            a.x / (this.a * Math.cos(this.lat0)));
        a.x = b;
        a.y = c
    }
};
Proj4js.Proj.merc = {
    init      : function(){
        this.lat_ts && (this.k0 = this.sphere? Math.cos(this.lat_ts) : Proj4js.common.msfnz(this.es, Math.sin(this.lat_ts), Math.cos(this.lat_ts)))
    }, forward: function(a){
        var c = a.x, b = a.y;
        if(90 < b * Proj4js.common.R2D && -90 > b * Proj4js.common.R2D && 180 < c * Proj4js.common.R2D && -180 > c * Proj4js.common.R2D) return Proj4js.reportError("merc:forward: llInputOutOfRange: " + c + " : " + b), null;
        if(Math.abs(Math.abs(b) - Proj4js.common.HALF_PI) <= Proj4js.common.EPSLN) return Proj4js.reportError("merc:forward: ll2mAtPoles"), null;
        if(this.sphere) c = this.x0 + this.a * this.k0 * Proj4js.common.adjust_lon(c - this.long0), b = this.y0 + this.a * this.k0 * Math.log(Math.tan(Proj4js.common.FORTPI + 0.5 * b));
        else var d = Math.sin(b), b = Proj4js.common.tsfnz(this.e, b, d),
            c = this.x0 + this.a * this.k0 * Proj4js.common.adjust_lon(c - this.long0),
            b = this.y0 - this.a * this.k0 * Math.log(b);
        a.x = c;
        a.y = b;
        return a
    }, inverse: function(a){
        var c = a.x - this.x0, b = a.y - this.y0;
        if(this.sphere) b = Proj4js.common.HALF_PI - 2 * Math.atan(Math.exp(-b / this.a * this.k0));
        else if(b = Math.exp(-b / (this.a * this.k0)),
                b = Proj4js.common.phi2z(this.e, b), -9999 == b) return Proj4js.reportError("merc:inverse: lat = -9999"), null;
        c = Proj4js.common.adjust_lon(this.long0 + c / (this.a * this.k0));
        a.x = c;
        a.y = b;
        return a
    }
};
Proj4js.Proj.utm = {
    dependsOn: "tmerc", init: function(){
        this.zone? (this.lat0 = 0, this.long0 = (6 * Math.abs(this.zone) - 183) * Proj4js.common.D2R, this.x0 = 5E5, this.y0 = this.utmSouth? 1E7 : 0, this.k0 = 0.9996, Proj4js.Proj.tmerc.init.apply(this), this.forward = Proj4js.Proj.tmerc.forward, this.inverse = Proj4js.Proj.tmerc.inverse) : Proj4js.reportError("utm:init: zone must be specified for UTM")
    }
};
Proj4js.Proj.eqdc = {
    init      : function(){
        this.mode || (this.mode = 0);
        this.temp = this.b / this.a;
        this.es = 1 - Math.pow(this.temp, 2);
        this.e = Math.sqrt(this.es);
        this.e0 = Proj4js.common.e0fn(this.es);
        this.e1 = Proj4js.common.e1fn(this.es);
        this.e2 = Proj4js.common.e2fn(this.es);
        this.e3 = Proj4js.common.e3fn(this.es);
        this.sinphi = Math.sin(this.lat1);
        this.cosphi = Math.cos(this.lat1);
        this.ms1 = Proj4js.common.msfnz(this.e, this.sinphi, this.cosphi);
        this.ml1 = Proj4js.common.mlfn(this.e0, this.e1, this.e2, this.e3, this.lat1);
        0 != this.mode?
            (Math.abs(this.lat1 + this.lat2) < Proj4js.common.EPSLN && Proj4js.reportError("eqdc:Init:EqualLatitudes"), this.sinphi = Math.sin(this.lat2), this.cosphi = Math.cos(this.lat2), this.ms2 = Proj4js.common.msfnz(this.e, this.sinphi, this.cosphi), this.ml2 = Proj4js.common.mlfn(this.e0, this.e1, this.e2, this.e3, this.lat2), this.ns = Math.abs(this.lat1 - this.lat2) >= Proj4js.common.EPSLN? (this.ms1 - this.ms2) / (this.ml2 - this.ml1) : this.sinphi) : this.ns = this.sinphi;
        this.g = this.ml1 + this.ms1 / this.ns;
        this.ml0 = Proj4js.common.mlfn(this.e0,
            this.e1, this.e2, this.e3, this.lat0);
        this.rh = this.a * (this.g - this.ml0)
    }, forward: function(a){
        var c = a.x, b = this.a * (this.g - Proj4js.common.mlfn(this.e0, this.e1, this.e2, this.e3, a.y)),
            d = this.ns * Proj4js.common.adjust_lon(c - this.long0), c = this.x0 + b * Math.sin(d),
            b = this.y0 + this.rh - b * Math.cos(d);
        a.x = c;
        a.y = b;
        return a
    }, inverse: function(a){
        a.x -= this.x0;
        a.y = this.rh - a.y + this.y0;
        var c, b;
        0 <= this.ns? (b = Math.sqrt(a.x * a.x + a.y * a.y), c = 1) : (b = -Math.sqrt(a.x * a.x + a.y * a.y), c = -1);
        var d = 0;
        0 != b && (d = Math.atan2(c * a.x, c * a.y));
        c = this.phi3z(this.g -
            b / this.a, this.e0, this.e1, this.e2, this.e3);
        d = Proj4js.common.adjust_lon(this.long0 + d / this.ns);
        a.x = d;
        a.y = c;
        return a
    }, phi3z  : function(a, c, b, d, e){
        var f, g;
        f = a;
        for(var i = 0 ; 15 > i ; i++) if(g = (a + b * Math.sin(2 * f) - d * Math.sin(4 * f) + e * Math.sin(6 * f)) / c - f, f += g, 1.0E-10 >= Math.abs(g)) return f;
        Proj4js.reportError("PHI3Z-CONV:Latitude failed to converge after 15 iterations");
        return null
    }
};
Proj4js.Proj.tmerc = {
    init      : function(){
        this.e0 = Proj4js.common.e0fn(this.es);
        this.e1 = Proj4js.common.e1fn(this.es);
        this.e2 = Proj4js.common.e2fn(this.es);
        this.e3 = Proj4js.common.e3fn(this.es);
        this.ml0 = this.a * Proj4js.common.mlfn(this.e0, this.e1, this.e2, this.e3, this.lat0)
    }, forward: function(a){
        var c = a.y, b = Proj4js.common.adjust_lon(a.x - this.long0), d, e;
        d = Math.sin(c);
        var f = Math.cos(c);
        if(this.sphere)
        {
            var g = f * Math.sin(b);
            if(1.0E-10 > Math.abs(Math.abs(g) - 1)) return Proj4js.reportError("tmerc:forward: Point projects into infinity"),
                93;
            e = 0.5 * this.a * this.k0 * Math.log((1 + g) / (1 - g));
            d = Math.acos(f * Math.cos(b) / Math.sqrt(1 - g * g));
            0 > c && (d = -d);
            c = this.a * this.k0 * (d - this.lat0)
        }
        else
        {
            e = f * b;
            var b = Math.pow(e, 2), f = this.ep2 * Math.pow(f, 2), g = Math.tan(c), i = Math.pow(g, 2);
            d = 1 - this.es * Math.pow(d, 2);
            d = this.a / Math.sqrt(d);
            c = this.a * Proj4js.common.mlfn(this.e0, this.e1, this.e2, this.e3, c);
            e = this.k0 * d * e * (1 + b / 6 * (1 - i + f + b / 20 * (5 - 18 * i + Math.pow(i, 2) + 72 * f - 58 * this.ep2))) + this.x0;
            c = this.k0 * (c - this.ml0 + d * g * b * (0.5 + b / 24 * (5 - i + 9 * f + 4 * Math.pow(f, 2) + b / 30 * (61 - 58 * i + Math.pow(i,
                2) + 600 * f - 330 * this.ep2)))) + this.y0
        }
        a.x = e;
        a.y = c;
        return a
    }, inverse: function(a){
        var c, b, d, e;
        if(this.sphere)
        {
            b = Math.exp(a.x / (this.a * this.k0));
            var f = 0.5 * (b - 1 / b);
            d = this.lat0 + a.y / (this.a * this.k0);
            e = Math.cos(d);
            c = Math.sqrt((1 - e * e) / (1 + f * f));
            b = Proj4js.common.asinz(c);
            0 > d && (b = -b);
            c = 0 == f && 0 == e? this.long0 : Proj4js.common.adjust_lon(Math.atan2(f, e) + this.long0)
        }
        else
        {
            var f = a.x - this.x0, g = a.y - this.y0;
            b = c = (this.ml0 + g / this.k0) / this.a;
            for(e = 0 ; ; e++)
            {
                d = (c + this.e1 * Math.sin(2 * b) - this.e2 * Math.sin(4 * b) + this.e3 * Math.sin(6 * b)) /
                    this.e0 - b;
                b += d;
                if(Math.abs(d) <= Proj4js.common.EPSLN) break;
                if(6 <= e) return Proj4js.reportError("tmerc:inverse: Latitude failed to converge"), 95
            }
            if(Math.abs(b) < Proj4js.common.HALF_PI)
            {
                c = Math.sin(b);
                d = Math.cos(b);
                var i = Math.tan(b);
                e = this.ep2 * Math.pow(d, 2);
                var g = Math.pow(e, 2), h = Math.pow(i, 2), j = Math.pow(h, 2);
                c = 1 - this.es * Math.pow(c, 2);
                var k = this.a / Math.sqrt(c);
                c = k * (1 - this.es) / c;
                var f = f / (k * this.k0), l = Math.pow(f, 2);
                b -= k * i * l / c * (0.5 - l / 24 * (5 + 3 * h + 10 * e - 4 * g - 9 * this.ep2 - l / 30 * (61 + 90 * h + 298 * e + 45 * j - 252 * this.ep2 - 3 * g)));
                c = Proj4js.common.adjust_lon(this.long0 + f * (1 - l / 6 * (1 + 2 * h + e - l / 20 * (5 - 2 * e + 28 * h - 3 * g + 8 * this.ep2 + 24 * j))) / d)
            }
            else b = Proj4js.common.HALF_PI * Proj4js.common.sign(g), c = this.long0
        }
        a.x = c;
        a.y = b;
        return a
    }
};
Proj4js.defs.GOOGLE = "+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +no_defs";
Proj4js.defs["EPSG:900913"] = Proj4js.defs.GOOGLE;
Proj4js.Proj.gstmerc = {
    init      : function(){
        var a = this.b / this.a;
        this.e = Math.sqrt(1 - a * a);
        this.lc = this.long0;
        this.rs = Math.sqrt(1 + this.e * this.e * Math.pow(Math.cos(this.lat0), 4) / (1 - this.e * this.e));
        var a = Math.sin(this.lat0), c = Math.asin(a / this.rs), b = Math.sin(c);
        this.cp = Proj4js.common.latiso(0, c, b) - this.rs * Proj4js.common.latiso(this.e, this.lat0, a);
        this.n2 = this.k0 * this.a * Math.sqrt(1 - this.e * this.e) / (1 - this.e * this.e * a * a);
        this.xs = this.x0;
        this.ys = this.y0 - this.n2 * c;
        this.title || (this.title = "Gauss Schreiber transverse mercator")
    },
    forward   : function(a){
        var c = a.y, b = this.rs * (a.x - this.lc),
            c = this.cp + this.rs * Proj4js.common.latiso(this.e, c, Math.sin(c)),
            d = Math.asin(Math.sin(b) / Proj4js.common.cosh(c)), d = Proj4js.common.latiso(0, d, Math.sin(d));
        a.x = this.xs + this.n2 * d;
        a.y = this.ys + this.n2 * Math.atan(Proj4js.common.sinh(c) / Math.cos(b));
        return a
    }, inverse: function(a){
        var c = a.x, b = a.y,
            d = Math.atan(Proj4js.common.sinh((c - this.xs) / this.n2) / Math.cos((b - this.ys) / this.n2)),
            c = Math.asin(Math.sin((b - this.ys) / this.n2) / Proj4js.common.cosh((c - this.xs) / this.n2)),
            c = Proj4js.common.latiso(0, c, Math.sin(c));
        a.x = this.lc + d / this.rs;
        a.y = Proj4js.common.invlatiso(this.e, (c - this.cp) / this.rs);
        return a
    }
};
Proj4js.Proj.ortho = {
    init      : function(){
        this.sin_p14 = Math.sin(this.lat0);
        this.cos_p14 = Math.cos(this.lat0)
    }, forward: function(a){
        var c, b, d, e, f;
        b = a.y;
        d = Proj4js.common.adjust_lon(a.x - this.long0);
        c = Math.sin(b);
        b = Math.cos(b);
        e = Math.cos(d);
        f = this.sin_p14 * c + this.cos_p14 * b * e;
        if(0 < f || Math.abs(f) <= Proj4js.common.EPSLN) var g = 1 * this.a * b * Math.sin(d),
            i = this.y0 + 1 * this.a * (this.cos_p14 * c - this.sin_p14 * b * e);
        else Proj4js.reportError("orthoFwdPointError");
        a.x = g;
        a.y = i;
        return a
    }, inverse: function(a){
        var c, b, d, e;
        a.x -= this.x0;
        a.y -= this.y0;
        c = Math.sqrt(a.x * a.x + a.y * a.y);
        c > this.a + 1.0E-7 && Proj4js.reportError("orthoInvDataError");
        b = Proj4js.common.asinz(c / this.a);
        d = Math.sin(b);
        e = Math.cos(b);
        b = this.long0;
        Math.abs(c);
        d = Proj4js.common.asinz(e * this.sin_p14 + a.y * d * this.cos_p14 / c);
        c = Math.abs(this.lat0) - Proj4js.common.HALF_PI;
        Math.abs(c) <= Proj4js.common.EPSLN && (b = 0 <= this.lat0? Proj4js.common.adjust_lon(this.long0 + Math.atan2(a.x, -a.y)) : Proj4js.common.adjust_lon(this.long0 - Math.atan2(-a.x, a.y)));
        Math.sin(d);
        a.x = b;
        a.y = d;
        return a
    }
};
Proj4js.Proj.krovak = {
    init      : function(){
        this.a = 6377397.155;
        this.es = 0.006674372230614;
        this.e = Math.sqrt(this.es);
        this.lat0 || (this.lat0 = 0.863937979737193);
        this.long0 || (this.long0 = 0.4334234309119251);
        this.k0 || (this.k0 = 0.9999);
        this.s45 = 0.785398163397448;
        this.s90 = 2 * this.s45;
        this.fi0 = this.lat0;
        this.e2 = this.es;
        this.e = Math.sqrt(this.e2);
        this.alfa = Math.sqrt(1 + this.e2 * Math.pow(Math.cos(this.fi0), 4) / (1 - this.e2));
        this.uq = 1.04216856380474;
        this.u0 = Math.asin(Math.sin(this.fi0) / this.alfa);
        this.g = Math.pow((1 + this.e * Math.sin(this.fi0)) /
            (1 - this.e * Math.sin(this.fi0)), this.alfa * this.e / 2);
        this.k = Math.tan(this.u0 / 2 + this.s45) / Math.pow(Math.tan(this.fi0 / 2 + this.s45), this.alfa) * this.g;
        this.k1 = this.k0;
        this.n0 = this.a * Math.sqrt(1 - this.e2) / (1 - this.e2 * Math.pow(Math.sin(this.fi0), 2));
        this.s0 = 1.37008346281555;
        this.n = Math.sin(this.s0);
        this.ro0 = this.k1 * this.n0 / Math.tan(this.s0);
        this.ad = this.s90 - this.uq
    }, forward: function(a){
        var c, b, d;
        b = a.y;
        d = Proj4js.common.adjust_lon(a.x - this.long0);
        c = Math.pow((1 + this.e * Math.sin(b)) / (1 - this.e * Math.sin(b)), this.alfa *
            this.e / 2);
        c = 2 * (Math.atan(this.k * Math.pow(Math.tan(b / 2 + this.s45), this.alfa) / c) - this.s45);
        b = -d * this.alfa;
        d = Math.asin(Math.cos(this.ad) * Math.sin(c) + Math.sin(this.ad) * Math.cos(c) * Math.cos(b));
        c = this.n * Math.asin(Math.cos(c) * Math.sin(b) / Math.cos(d));
        d = this.ro0 * Math.pow(Math.tan(this.s0 / 2 + this.s45), this.n) / Math.pow(Math.tan(d / 2 + this.s45), this.n);
        a.y = d * Math.cos(c) / 1;
        a.x = d * Math.sin(c) / 1;
        this.czech && (a.y *= -1, a.x *= -1);
        return a
    }, inverse: function(a){
        var c, b, d;
        c = a.x;
        a.x = a.y;
        a.y = c;
        this.czech && (a.y *= -1, a.x *= -1);
        c = Math.sqrt(a.x * a.x + a.y * a.y);
        b = Math.atan2(a.y, a.x) / Math.sin(this.s0);
        d = 2 * (Math.atan(Math.pow(this.ro0 / c, 1 / this.n) * Math.tan(this.s0 / 2 + this.s45)) - this.s45);
        c = Math.asin(Math.cos(this.ad) * Math.sin(d) - Math.sin(this.ad) * Math.cos(d) * Math.cos(b));
        b = Math.asin(Math.cos(d) * Math.sin(b) / Math.cos(c));
        a.x = this.long0 - b / this.alfa;
        b = c;
        var e = d = 0;
        do a.y = 2 * (Math.atan(Math.pow(this.k, -1 / this.alfa) * Math.pow(Math.tan(c / 2 + this.s45), 1 / this.alfa) * Math.pow((1 + this.e * Math.sin(b)) / (1 - this.e * Math.sin(b)), this.e / 2)) - this.s45), 1.0E-10 >
        Math.abs(b - a.y) && (d = 1), b = a.y, e += 1;while(0 == d && 15 > e);
        return 15 <= e? (Proj4js.reportError("PHI3Z-CONV:Latitude failed to converge after 15 iterations"), null) : a
    }
};
Proj4js.Proj.somerc = {
    init      : function(){
        var a = this.lat0;
        this.lambda0 = this.long0;
        var c = Math.sin(a), b = this.a, d = 1 / this.rf, d = 2 * d - Math.pow(d, 2), e = this.e = Math.sqrt(d);
        this.R = this.k0 * b * Math.sqrt(1 - d) / (1 - d * Math.pow(c, 2));
        this.alpha = Math.sqrt(1 + d / (1 - d) * Math.pow(Math.cos(a), 4));
        this.b0 = Math.asin(c / this.alpha);
        this.K = Math.log(Math.tan(Math.PI / 4 + this.b0 / 2)) - this.alpha * Math.log(Math.tan(Math.PI / 4 + a / 2)) + this.alpha * e / 2 * Math.log((1 + e * c) / (1 - e * c))
    }, forward: function(a){
        var c = Math.log(Math.tan(Math.PI / 4 - a.y / 2)), b = this.e /
            2 * Math.log((1 + this.e * Math.sin(a.y)) / (1 - this.e * Math.sin(a.y))),
            b = 2 * (Math.atan(Math.exp(-this.alpha * (c + b) + this.K)) - Math.PI / 4),
            d = this.alpha * (a.x - this.lambda0),
            c = Math.atan(Math.sin(d) / (Math.sin(this.b0) * Math.tan(b) + Math.cos(this.b0) * Math.cos(d))),
            b = Math.asin(Math.cos(this.b0) * Math.sin(b) - Math.sin(this.b0) * Math.cos(b) * Math.cos(d));
        a.y = this.R / 2 * Math.log((1 + Math.sin(b)) / (1 - Math.sin(b))) + this.y0;
        a.x = this.R * c + this.x0;
        return a
    }, inverse: function(a){
        for(var c = (a.x - this.x0) / this.R, b = 2 * (Math.atan(Math.exp((a.y -
            this.y0) / this.R)) - Math.PI / 4), d = Math.asin(Math.cos(this.b0) * Math.sin(b) + Math.sin(this.b0) * Math.cos(b) * Math.cos(c)), c = this.lambda0 + Math.atan(Math.sin(c) / (Math.cos(this.b0) * Math.cos(c) - Math.sin(this.b0) * Math.tan(b))) / this.alpha, b = 0, e = d, f = -1E3, g = 0 ; 1.0E-7 < Math.abs(e - f) ;)
        {
            if(20 < ++g)
            {
                Proj4js.reportError("omercFwdInfinity");
                return
            }
            b = 1 / this.alpha * (Math.log(Math.tan(Math.PI / 4 + d / 2)) - this.K) + this.e * Math.log(Math.tan(Math.PI / 4 + Math.asin(this.e * Math.sin(e)) / 2));
            f = e;
            e = 2 * Math.atan(Math.exp(b)) - Math.PI / 2
        }
        a.x = c;
        a.y =
            e;
        return a
    }
};
Proj4js.Proj.stere = {
    ssfn_     : function(a, c, b){
        c *= b;
        return Math.tan(0.5 * (Proj4js.common.HALF_PI + a)) * Math.pow((1 - c) / (1 + c), 0.5 * b)
    }, TOL    : 1.0E-8, NITER: 8, CONV: 1.0E-10, S_POLE: 0, N_POLE: 1, OBLIQ: 2, EQUIT: 3, init: function(){
        this.phits = this.lat_ts? this.lat_ts : Proj4js.common.HALF_PI;
        var a = Math.abs(this.lat0);
        this.mode = Math.abs(a) - Proj4js.common.HALF_PI < Proj4js.common.EPSLN? 0 > this.lat0? this.S_POLE : this.N_POLE : a > Proj4js.common.EPSLN? this.OBLIQ : this.EQUIT;
        this.phits = Math.abs(this.phits);
        if(this.es)
        {
            var c;
            switch(this.mode)
            {
                case this.N_POLE:
                case this.S_POLE:
                    Math.abs(this.phits - Proj4js.common.HALF_PI) <
                    Proj4js.common.EPSLN? this.akm1 = 2 * this.k0 / Math.sqrt(Math.pow(1 + this.e, 1 + this.e) * Math.pow(1 - this.e, 1 - this.e)) : (a = Math.sin(this.phits), this.akm1 = Math.cos(this.phits) / Proj4js.common.tsfnz(this.e, this.phits, a), a *= this.e, this.akm1 /= Math.sqrt(1 - a * a));
                    break;
                case this.EQUIT:
                    this.akm1 = 2 * this.k0;
                    break;
                case this.OBLIQ:
                    a = Math.sin(this.lat0), c = 2 * Math.atan(this.ssfn_(this.lat0, a, this.e)) - Proj4js.common.HALF_PI, a *= this.e, this.akm1 = 2 * this.k0 * Math.cos(this.lat0) / Math.sqrt(1 - a * a), this.sinX1 = Math.sin(c), this.cosX1 = Math.cos(c)
            }
        }
        else switch(this.mode)
        {
            case this.OBLIQ:
                this.sinph0 =
                    Math.sin(this.lat0), this.cosph0 = Math.cos(this.lat0);
            case this.EQUIT:
                this.akm1 = 2 * this.k0;
                break;
            case this.S_POLE:
            case this.N_POLE:
                this.akm1 = Math.abs(this.phits - Proj4js.common.HALF_PI) >= Proj4js.common.EPSLN? Math.cos(this.phits) / Math.tan(Proj4js.common.FORTPI - 0.5 * this.phits) : 2 * this.k0
        }
    }, forward: function(a){
        var c = a.x, c = Proj4js.common.adjust_lon(c - this.long0), b = a.y, d, e;
        if(this.sphere)
        {
            var f, g, i;
            f = Math.sin(b);
            g = Math.cos(b);
            i = Math.cos(c);
            c = Math.sin(c);
            switch(this.mode)
            {
                case this.EQUIT:
                    e = 1 + g * i;
                    e <= Proj4js.common.EPSLN &&
                    Proj4js.reportError("stere:forward:Equit");
                    e = this.akm1 / e;
                    d = e * g * c;
                    e *= f;
                    break;
                case this.OBLIQ:
                    e = 1 + this.sinph0 * f + this.cosph0 * g * i;
                    e <= Proj4js.common.EPSLN && Proj4js.reportError("stere:forward:Obliq");
                    e = this.akm1 / e;
                    d = e * g * c;
                    e *= this.cosph0 * f - this.sinph0 * g * i;
                    break;
                case this.N_POLE:
                    i = -i, b = -b;
                case this.S_POLE:
                    Math.abs(b - Proj4js.common.HALF_PI) < this.TOL && Proj4js.reportError("stere:forward:S_POLE"), e = this.akm1 * Math.tan(Proj4js.common.FORTPI + 0.5 * b), d = c * e, e *= i
            }
        }
        else
        {
            i = Math.cos(c);
            c = Math.sin(c);
            f = Math.sin(b);
            var h;
            if(this.mode == this.OBLIQ || this.mode == this.EQUIT) h = 2 * Math.atan(this.ssfn_(b, f, this.e)), g = Math.sin(h - Proj4js.common.HALF_PI), h = Math.cos(h);
            switch(this.mode)
            {
                case this.OBLIQ:
                    b = this.akm1 / (this.cosX1 * (1 + this.sinX1 * g + this.cosX1 * h * i));
                    e = b * (this.cosX1 * g - this.sinX1 * h * i);
                    d = b * h;
                    break;
                case this.EQUIT:
                    b = 2 * this.akm1 / (1 + h * i);
                    e = b * g;
                    d = b * h;
                    break;
                case this.S_POLE:
                    b = -b, i = -i, f = -f;
                case this.N_POLE:
                    d = this.akm1 * Proj4js.common.tsfnz(this.e, b, f), e = -d * i
            }
            d *= c
        }
        a.x = d * this.a + this.x0;
        a.y = e * this.a + this.y0;
        return a
    }, inverse: function(a){
        var c =
            (a.x - this.x0) / this.a, b = (a.y - this.y0) / this.a, d, e, f, g = d = 0, i, h = f = 0;
        if(this.sphere)
        {
            g = Math.sqrt(c * c + b * b);
            h = 2 * Math.atan(g / this.akm1);
            f = Math.sin(h);
            h = Math.cos(h);
            d = 0;
            switch(this.mode)
            {
                case this.EQUIT:
                    e = Math.abs(g) <= Proj4js.common.EPSLN? 0 : Math.asin(b * f / g);
                    if(0 != h || 0 != c) d = Math.atan2(c * f, h * g);
                    break;
                case this.OBLIQ:
                    e = Math.abs(g) <= Proj4js.common.EPSLN? this.phi0 : Math.asin(h * this.sinph0 + b * f * this.cosph0 / g);
                    h -= this.sinph0 * Math.sin(e);
                    if(0 != h || 0 != c) d = Math.atan2(c * f * this.cosph0, h * g);
                    break;
                case this.N_POLE:
                    b = -b;
                case this.S_POLE:
                    e =
                        Math.abs(g) <= Proj4js.common.EPSLN? this.phi0 : Math.asin(this.mode == this.S_POLE? -h : h), d = 0 == c && 0 == b? 0 : Math.atan2(c, b)
            }
            a.x = Proj4js.common.adjust_lon(d + this.long0);
            a.y = e
        }
        else
        {
            i = Math.sqrt(c * c + b * b);
            switch(this.mode)
            {
                case this.OBLIQ:
                case this.EQUIT:
                    d = 2 * Math.atan2(i * this.cosX1, this.akm1);
                    f = Math.cos(d);
                    e = Math.sin(d);
                    g = 0 == i? Math.asin(f * this.sinX1) : Math.asin(f * this.sinX1 + b * e * this.cosX1 / i);
                    d = Math.tan(0.5 * (Proj4js.common.HALF_PI + g));
                    c *= e;
                    b = i * this.cosX1 * f - b * this.sinX1 * e;
                    h = Proj4js.common.HALF_PI;
                    f = 0.5 * this.e;
                    break;
                case this.N_POLE:
                    b = -b;
                case this.S_POLE:
                    d = -i / this.akm1, g = Proj4js.common.HALF_PI - 2 * Math.atan(d), h = -Proj4js.common.HALF_PI, f = -0.5 * this.e
            }
            for(i = this.NITER ; i-- ; g = e) if(e = this.e * Math.sin(g), e = 2 * Math.atan(d * Math.pow((1 + e) / (1 - e), f)) - h, Math.abs(g - e) < this.CONV) return this.mode == this.S_POLE && (e = -e), d = 0 == c && 0 == b? 0 : Math.atan2(c, b), a.x = Proj4js.common.adjust_lon(d + this.long0), a.y = e, a
        }
    }
};
Proj4js.Proj.nzmg = {
    iterations: 1, init: function(){
        this.A = [];
        this.A[1] = 0.6399175073;
        this.A[2] = -0.1358797613;
        this.A[3] = 0.063294409;
        this.A[4] = -0.02526853;
        this.A[5] = 0.0117879;
        this.A[6] = -0.0055161;
        this.A[7] = 0.0026906;
        this.A[8] = -0.001333;
        this.A[9] = 6.7E-4;
        this.A[10] = -3.4E-4;
        this.B_re = [];
        this.B_im = [];
        this.B_re[1] = 0.7557853228;
        this.B_im[1] = 0;
        this.B_re[2] = 0.249204646;
        this.B_im[2] = 0.003371507;
        this.B_re[3] = -0.001541739;
        this.B_im[3] = 0.04105856;
        this.B_re[4] = -0.10162907;
        this.B_im[4] = 0.01727609;
        this.B_re[5] = -0.26623489;
        this.B_im[5] = -0.36249218;
        this.B_re[6] = -0.6870983;
        this.B_im[6] = -1.1651967;
        this.C_re = [];
        this.C_im = [];
        this.C_re[1] = 1.3231270439;
        this.C_im[1] = 0;
        this.C_re[2] = -0.577245789;
        this.C_im[2] = -0.007809598;
        this.C_re[3] = 0.508307513;
        this.C_im[3] = -0.112208952;
        this.C_re[4] = -0.15094762;
        this.C_im[4] = 0.18200602;
        this.C_re[5] = 1.01418179;
        this.C_im[5] = 1.64497696;
        this.C_re[6] = 1.9660549;
        this.C_im[6] = 2.5127645;
        this.D = [];
        this.D[1] = 1.5627014243;
        this.D[2] = 0.5185406398;
        this.D[3] = -0.03333098;
        this.D[4] = -0.1052906;
        this.D[5] = -0.0368594;
        this.D[6] = 0.007317;
        this.D[7] = 0.0122;
        this.D[8] = 0.00394;
        this.D[9] = -0.0013
    }, forward: function(a){
        for(var c = 1.0E-5 * ((a.y - this.lat0) / Proj4js.common.SEC_TO_RAD), b = a.x - this.long0, d = 1, e = 0, f = 1 ; 10 >= f ; f++) d *= c, e += this.A[f] * d;
        for(var c = e, d = 1, g = 0, i = 0, h = 0, f = 1 ; 6 >= f ; f++) e = d * c - g * b, g = g * c + d * b, d = e, i = i + this.B_re[f] * d - this.B_im[f] * g, h = h + this.B_im[f] * d + this.B_re[f] * g;
        a.x = h * this.a + this.x0;
        a.y = i * this.a + this.y0;
        return a
    }, inverse: function(a){
        for(var c = (a.y - this.y0) / this.a, b = (a.x - this.x0) / this.a, d = 1, e = 0, f, g = 0, i = 0, h = 1 ; 6 >= h ; h++) f =
            d * c - e * b, e = e * c + d * b, d = f, g = g + this.C_re[h] * d - this.C_im[h] * e, i = i + this.C_im[h] * d + this.C_re[h] * e;
        for(d = 0 ; d < this.iterations ; d++)
        {
            var j = g, k = i, l;
            f = c;
            e = b;
            for(h = 2 ; 6 >= h ; h++) l = j * g - k * i, k = k * g + j * i, j = l, f += (h - 1) * (this.B_re[h] * j - this.B_im[h] * k), e += (h - 1) * (this.B_im[h] * j + this.B_re[h] * k);
            for(var j = 1, k = 0, m = this.B_re[1], n = this.B_im[1], h = 2 ; 6 >= h ; h++) l = j * g - k * i, k = k * g + j * i, j = l, m += h * (this.B_re[h] * j - this.B_im[h] * k), n += h * (this.B_im[h] * j + this.B_re[h] * k);
            i = m * m + n * n;
            g = (f * m + e * n) / i;
            i = (e * m - f * n) / i
        }
        c = g;
        b = 1;
        g = 0;
        for(h = 1 ; 9 >= h ; h++) b *= c, g += this.D[h] *
            b;
        h = this.lat0 + 1E5 * g * Proj4js.common.SEC_TO_RAD;
        a.x = this.long0 + i;
        a.y = h;
        return a
    }
};
Proj4js.Proj.mill = {
    init      : function(){
    }, forward: function(a){
        var c = a.y, b = this.x0 + this.a * Proj4js.common.adjust_lon(a.x - this.long0),
            c = this.y0 + 1.25 * this.a * Math.log(Math.tan(Proj4js.common.PI / 4 + c / 2.5));
        a.x = b;
        a.y = c;
        return a
    }, inverse: function(a){
        a.x -= this.x0;
        a.y -= this.y0;
        var c = Proj4js.common.adjust_lon(this.long0 + a.x / this.a),
            b = 2.5 * (Math.atan(Math.exp(0.8 * a.y / this.a)) - Proj4js.common.PI / 4);
        a.x = c;
        a.y = b;
        return a
    }
};
Proj4js.Proj.gnom = {
    init      : function(){
        this.sin_p14 = Math.sin(this.lat0);
        this.cos_p14 = Math.cos(this.lat0);
        this.infinity_dist = 1E3 * this.a;
        this.rc = 1
    }, forward: function(a){
        var c, b, d, e, f;
        b = a.y;
        d = Proj4js.common.adjust_lon(a.x - this.long0);
        c = Math.sin(b);
        b = Math.cos(b);
        e = Math.cos(d);
        f = this.sin_p14 * c + this.cos_p14 * b * e;
        0 < f || Math.abs(f) <= Proj4js.common.EPSLN? (d = this.x0 + 1 * this.a * b * Math.sin(d) / f, c = this.y0 + 1 * this.a * (this.cos_p14 * c - this.sin_p14 * b * e) / f) : (Proj4js.reportError("orthoFwdPointError"), d = this.x0 + this.infinity_dist *
            b * Math.sin(d), c = this.y0 + this.infinity_dist * (this.cos_p14 * c - this.sin_p14 * b * e));
        a.x = d;
        a.y = c;
        return a
    }, inverse: function(a){
        var c, b, d, e;
        a.x = (a.x - this.x0) / this.a;
        a.y = (a.y - this.y0) / this.a;
        a.x /= this.k0;
        a.y /= this.k0;
        (c = Math.sqrt(a.x * a.x + a.y * a.y))? (e = Math.atan2(c, this.rc), b = Math.sin(e), d = Math.cos(e), e = Proj4js.common.asinz(d * this.sin_p14 + a.y * b * this.cos_p14 / c), c = Math.atan2(a.x * b, c * this.cos_p14 * d - a.y * this.sin_p14 * b), c = Proj4js.common.adjust_lon(this.long0 + c)) : (e = this.phic0, c = 0);
        a.x = c;
        a.y = e;
        return a
    }
};
Proj4js.Proj.sinu = {
    init      : function(){
        this.sphere? (this.n = 1, this.es = this.m = 0, this.C_y = Math.sqrt((this.m + 1) / this.n), this.C_x = this.C_y / (this.m + 1)) : this.en = Proj4js.common.pj_enfn(this.es)
    }, forward: function(a){
        var c, b;
        c = a.x;
        b = a.y;
        c = Proj4js.common.adjust_lon(c - this.long0);
        if(this.sphere)
        {
            if(this.m) for(var d = this.n * Math.sin(b), e = Proj4js.common.MAX_ITER ; e ; --e)
            {
                var f = (this.m * b + Math.sin(b) - d) / (this.m + Math.cos(b));
                b -= f;
                if(Math.abs(f) < Proj4js.common.EPSLN) break
            }
            else b = 1 != this.n? Math.asin(this.n * Math.sin(b)) : b;
            c = this.a * this.C_x * c * (this.m + Math.cos(b));
            b *= this.a * this.C_y
        }
        else d = Math.sin(b), e = Math.cos(b), b = this.a * Proj4js.common.pj_mlfn(b, d, e, this.en), c = this.a * c * e / Math.sqrt(1 - this.es * d * d);
        a.x = c;
        a.y = b;
        return a
    }, inverse: function(a){
        var c, b;
        a.x -= this.x0;
        a.y -= this.y0;
        if(this.sphere) a.y /= this.C_y, c = this.m? Math.asin((this.m * a.y + Math.sin(a.y)) / this.n) : 1 != this.n? Math.asin(Math.sin(a.y) / this.n) : a.y, b = a.x / (this.C_x * (this.m + Math.cos(a.y)));
        else
        {
            c = Proj4js.common.pj_inv_mlfn(a.y / this.a, this.es, this.en);
            var d = Math.abs(c);
            d < Proj4js.common.HALF_PI? (d = Math.sin(c), b = this.long0 + a.x * Math.sqrt(1 - this.es * d * d) / (this.a * Math.cos(c)), b = Proj4js.common.adjust_lon(b)) : d - Proj4js.common.EPSLN < Proj4js.common.HALF_PI && (b = this.long0)
        }
        a.x = b;
        a.y = c;
        return a
    }
};
Proj4js.Proj.vandg = {
    init      : function(){
        this.R = 6370997
    }, forward: function(a){
        var c = a.y, b = Proj4js.common.adjust_lon(a.x - this.long0);
        Math.abs(c);
        var d = Proj4js.common.asinz(2 * Math.abs(c / Proj4js.common.PI));
        (Math.abs(b) <= Proj4js.common.EPSLN || Math.abs(Math.abs(c) - Proj4js.common.HALF_PI) <= Proj4js.common.EPSLN) && Math.tan(0.5 * d);
        var e = 0.5 * Math.abs(Proj4js.common.PI / b - b / Proj4js.common.PI), f = e * e, g = Math.sin(d),
            d = Math.cos(d), d = d / (g + d - 1), g = d * (2 / g - 1), g = g * g,
            f = Proj4js.common.PI * this.R * (e * (d - g) + Math.sqrt(f * (d - g) * (d - g) -
                (g + f) * (d * d - g))) / (g + f);
        0 > b && (f = -f);
        b = this.x0 + f;
        f = Math.abs(f / (Proj4js.common.PI * this.R));
        c = 0 <= c? this.y0 + Proj4js.common.PI * this.R * Math.sqrt(1 - f * f - 2 * e * f) : this.y0 - Proj4js.common.PI * this.R * Math.sqrt(1 - f * f - 2 * e * f);
        a.x = b;
        a.y = c;
        return a
    }, inverse: function(a){
        var c, b, d, e, f, g, i, h;
        a.x -= this.x0;
        a.y -= this.y0;
        h = Proj4js.common.PI * this.R;
        c = a.x / h;
        d = a.y / h;
        e = c * c + d * d;
        f = -Math.abs(d) * (1 + e);
        b = f - 2 * d * d + c * c;
        g = -2 * f + 1 + 2 * d * d + e * e;
        h = d * d / g + (2 * b * b * b / g / g / g - 9 * f * b / g / g) / 27;
        i = (f - b * b / 3 / g) / g;
        f = 2 * Math.sqrt(-i / 3);
        h = 3 * h / i / f;
        1 < Math.abs(h) && (h =
            0 <= h? 1 : -1);
        h = Math.acos(h) / 3;
        b = 0 <= a.y? (-f * Math.cos(h + Proj4js.common.PI / 3) - b / 3 / g) * Proj4js.common.PI : -(-f * Math.cos(h + Proj4js.common.PI / 3) - b / 3 / g) * Proj4js.common.PI;
        Math.abs(c);
        c = Proj4js.common.adjust_lon(this.long0 + Proj4js.common.PI * (e - 1 + Math.sqrt(1 + 2 * (c * c - d * d) + e * e)) / 2 / c);
        a.x = c;
        a.y = b;
        return a
    }
};
Proj4js.Proj.cea = {
    init      : function(){
    }, forward: function(a){
        var c = a.y, b = this.x0 + this.a * Proj4js.common.adjust_lon(a.x - this.long0) * Math.cos(this.lat_ts),
            c = this.y0 + this.a * Math.sin(c) / Math.cos(this.lat_ts);
        a.x = b;
        a.y = c;
        return a
    }, inverse: function(a){
        a.x -= this.x0;
        a.y -= this.y0;
        var c = Proj4js.common.adjust_lon(this.long0 + a.x / this.a / Math.cos(this.lat_ts)),
            b = Math.asin(a.y / this.a * Math.cos(this.lat_ts));
        a.x = c;
        a.y = b;
        return a
    }
};
Proj4js.Proj.eqc = {
    init      : function(){
        this.x0 || (this.x0 = 0);
        this.y0 || (this.y0 = 0);
        this.lat0 || (this.lat0 = 0);
        this.long0 || (this.long0 = 0);
        this.lat_ts || (this.lat_ts = 0);
        this.title || (this.title = "Equidistant Cylindrical (Plate Carre)");
        this.rc = Math.cos(this.lat_ts)
    }, forward: function(a){
        var c = a.y, b = Proj4js.common.adjust_lon(a.x - this.long0), c = Proj4js.common.adjust_lat(c - this.lat0);
        a.x = this.x0 + this.a * b * this.rc;
        a.y = this.y0 + this.a * c;
        return a
    }, inverse: function(a){
        var c = a.y;
        a.x = Proj4js.common.adjust_lon(this.long0 + (a.x -
            this.x0) / (this.a * this.rc));
        a.y = Proj4js.common.adjust_lat(this.lat0 + (c - this.y0) / this.a);
        return a
    }
};
Proj4js.Proj.cass = {
    init   : function(){
        this.sphere || (this.en = Proj4js.common.pj_enfn(this.es), this.m0 = Proj4js.common.pj_mlfn(this.lat0, Math.sin(this.lat0), Math.cos(this.lat0), this.en))
    },
    C1     : 0.16666666666666666,
    C2     : 0.008333333333333333,
    C3     : 0.041666666666666664,
    C4     : 0.3333333333333333,
    C5     : 0.06666666666666667,
    forward: function(a){
        var c, b, d = a.x, e = a.y, d = Proj4js.common.adjust_lon(d - this.long0);
        this.sphere? (c = Math.asin(Math.cos(e) * Math.sin(d)), b = Math.atan2(Math.tan(e), Math.cos(d)) - this.phi0) : (this.n = Math.sin(e), this.c =
            Math.cos(e), b = Proj4js.common.pj_mlfn(e, this.n, this.c, this.en), this.n = 1 / Math.sqrt(1 - this.es * this.n * this.n), this.tn = Math.tan(e), this.t = this.tn * this.tn, this.a1 = d * this.c, this.c *= this.es * this.c / (1 - this.es), this.a2 = this.a1 * this.a1, c = this.n * this.a1 * (1 - this.a2 * this.t * (this.C1 - (8 - this.t + 8 * this.c) * this.a2 * this.C2)), b -= this.m0 - this.n * this.tn * this.a2 * (0.5 + (5 - this.t + 6 * this.c) * this.a2 * this.C3));
        a.x = this.a * c + this.x0;
        a.y = this.a * b + this.y0;
        return a
    },
    inverse: function(a){
        a.x -= this.x0;
        a.y -= this.y0;
        var c = a.x / this.a, b =
            a.y / this.a;
        if(this.sphere) this.dd = b + this.lat0, b = Math.asin(Math.sin(this.dd) * Math.cos(c)), c = Math.atan2(Math.tan(c), Math.cos(this.dd));
        else
        {
            var d = Proj4js.common.pj_inv_mlfn(this.m0 + b, this.es, this.en);
            this.tn = Math.tan(d);
            this.t = this.tn * this.tn;
            this.n = Math.sin(d);
            this.r = 1 / (1 - this.es * this.n * this.n);
            this.n = Math.sqrt(this.r);
            this.r *= (1 - this.es) * this.n;
            this.dd = c / this.n;
            this.d2 = this.dd * this.dd;
            b = d - this.n * this.tn / this.r * this.d2 * (0.5 - (1 + 3 * this.t) * this.d2 * this.C3);
            c = this.dd * (1 + this.t * this.d2 * (-this.C4 + (1 + 3 * this.t) *
                this.d2 * this.C5)) / Math.cos(d)
        }
        a.x = Proj4js.common.adjust_lon(this.long0 + c);
        a.y = b;
        return a
    }
};
Proj4js.Proj.gauss = {
    init      : function(){
        var a = Math.sin(this.lat0), c = Math.cos(this.lat0), c = c * c;
        this.rc = Math.sqrt(1 - this.es) / (1 - this.es * a * a);
        this.C = Math.sqrt(1 + this.es * c * c / (1 - this.es));
        this.phic0 = Math.asin(a / this.C);
        this.ratexp = 0.5 * this.C * this.e;
        this.K = Math.tan(0.5 * this.phic0 + Proj4js.common.FORTPI) / (Math.pow(Math.tan(0.5 * this.lat0 + Proj4js.common.FORTPI), this.C) * Proj4js.common.srat(this.e * a, this.ratexp))
    }, forward: function(a){
        var c = a.x, b = a.y;
        a.y = 2 * Math.atan(this.K * Math.pow(Math.tan(0.5 * b + Proj4js.common.FORTPI),
            this.C) * Proj4js.common.srat(this.e * Math.sin(b), this.ratexp)) - Proj4js.common.HALF_PI;
        a.x = this.C * c;
        return a
    }, inverse: function(a){
        for(var c = a.x / this.C, b = a.y, d = Math.pow(Math.tan(0.5 * b + Proj4js.common.FORTPI) / this.K, 1 / this.C), e = Proj4js.common.MAX_ITER ; 0 < e ; --e)
        {
            b = 2 * Math.atan(d * Proj4js.common.srat(this.e * Math.sin(a.y), -0.5 * this.e)) - Proj4js.common.HALF_PI;
            if(1.0E-14 > Math.abs(b - a.y)) break;
            a.y = b
        }
        if(!e) return Proj4js.reportError("gauss:inverse:convergence failed"), null;
        a.x = c;
        a.y = b;
        return a
    }
};
Proj4js.Proj.omerc = {
    init      : function(){
        this.mode || (this.mode = 0);
        this.lon1 || (this.lon1 = 0, this.mode = 1);
        this.lon2 || (this.lon2 = 0);
        this.lat2 || (this.lat2 = 0);
        var a = 1 - Math.pow(this.b / this.a, 2);
        Math.sqrt(a);
        this.sin_p20 = Math.sin(this.lat0);
        this.cos_p20 = Math.cos(this.lat0);
        this.con = 1 - this.es * this.sin_p20 * this.sin_p20;
        this.com = Math.sqrt(1 - a);
        this.bl = Math.sqrt(1 + this.es * Math.pow(this.cos_p20, 4) / (1 - a));
        this.al = this.a * this.bl * this.k0 * this.com / this.con;
        Math.abs(this.lat0) < Proj4js.common.EPSLN? this.el = this.d = this.ts =
            1 : (this.ts = Proj4js.common.tsfnz(this.e, this.lat0, this.sin_p20), this.con = Math.sqrt(this.con), this.d = this.bl * this.com / (this.cos_p20 * this.con), this.f = 0 < this.d * this.d - 1? 0 <= this.lat0? this.d + Math.sqrt(this.d * this.d - 1) : this.d - Math.sqrt(this.d * this.d - 1) : this.d, this.el = this.f * Math.pow(this.ts, this.bl));
        0 != this.mode? (this.g = 0.5 * (this.f - 1 / this.f), this.gama = Proj4js.common.asinz(Math.sin(this.alpha) / this.d), this.longc -= Proj4js.common.asinz(this.g * Math.tan(this.gama)) / this.bl, this.con = Math.abs(this.lat0), this.con >
        Proj4js.common.EPSLN && Math.abs(this.con - Proj4js.common.HALF_PI) > Proj4js.common.EPSLN? (this.singam = Math.sin(this.gama), this.cosgam = Math.cos(this.gama), this.sinaz = Math.sin(this.alpha), this.cosaz = Math.cos(this.alpha), this.u = 0 <= this.lat0? this.al / this.bl * Math.atan(Math.sqrt(this.d * this.d - 1) / this.cosaz) : -(this.al / this.bl) * Math.atan(Math.sqrt(this.d * this.d - 1) / this.cosaz)) : Proj4js.reportError("omerc:Init:DataError")) : (this.sinphi = Math.sin(this.at1), this.ts1 = Proj4js.common.tsfnz(this.e, this.lat1, this.sinphi),
            this.sinphi = Math.sin(this.lat2), this.ts2 = Proj4js.common.tsfnz(this.e, this.lat2, this.sinphi), this.h = Math.pow(this.ts1, this.bl), this.l = Math.pow(this.ts2, this.bl), this.f = this.el / this.h, this.g = 0.5 * (this.f - 1 / this.f), this.j = (this.el * this.el - this.l * this.h) / (this.el * this.el + this.l * this.h), this.p = (this.l - this.h) / (this.l + this.h), this.dlon = this.lon1 - this.lon2, this.dlon < -Proj4js.common.PI && (this.lon2 -= 2 * Proj4js.common.PI), this.dlon > Proj4js.common.PI && (this.lon2 += 2 * Proj4js.common.PI), this.dlon = this.lon1 - this.lon2,
            this.longc = 0.5 * (this.lon1 + this.lon2) - Math.atan(this.j * Math.tan(0.5 * this.bl * this.dlon) / this.p) / this.bl, this.dlon = Proj4js.common.adjust_lon(this.lon1 - this.longc), this.gama = Math.atan(Math.sin(this.bl * this.dlon) / this.g), this.alpha = Proj4js.common.asinz(this.d * Math.sin(this.gama)), Math.abs(this.lat1 - this.lat2) <= Proj4js.common.EPSLN? Proj4js.reportError("omercInitDataError") : this.con = Math.abs(this.lat1), this.con <= Proj4js.common.EPSLN || Math.abs(this.con - Proj4js.common.HALF_PI) <= Proj4js.common.EPSLN? Proj4js.reportError("omercInitDataError") :
            Math.abs(Math.abs(this.lat0) - Proj4js.common.HALF_PI) <= Proj4js.common.EPSLN && Proj4js.reportError("omercInitDataError"), this.singam = Math.sin(this.gam), this.cosgam = Math.cos(this.gam), this.sinaz = Math.sin(this.alpha), this.cosaz = Math.cos(this.alpha), this.u = 0 <= this.lat0? this.al / this.bl * Math.atan(Math.sqrt(this.d * this.d - 1) / this.cosaz) : -(this.al / this.bl) * Math.atan(Math.sqrt(this.d * this.d - 1) / this.cosaz))
    }, forward: function(a){
        var c, b, d, e, f;
        d = a.x;
        b = a.y;
        c = Math.sin(b);
        e = Proj4js.common.adjust_lon(d - this.longc);
        d = Math.sin(this.bl * e);
        Math.abs(Math.abs(b) - Proj4js.common.HALF_PI) > Proj4js.common.EPSLN? (c = Proj4js.common.tsfnz(this.e, b, c), c = this.el / Math.pow(c, this.bl), f = 0.5 * (c - 1 / c), c = (f * this.singam - d * this.cosgam) / (0.5 * (c + 1 / c)), b = Math.cos(this.bl * e), 1.0E-7 > Math.abs(b)? d = this.al * this.bl * e : (d = this.al * Math.atan((f * this.cosgam + d * this.singam) / b) / this.bl, 0 > b && (d += Proj4js.common.PI * this.al / this.bl))) : (c = 0 <= b? this.singam : -this.singam, d = this.al * b / this.bl);
        Math.abs(Math.abs(c) - 1) <= Proj4js.common.EPSLN && Proj4js.reportError("omercFwdInfinity");
        e = 0.5 * this.al * Math.log((1 - c) / (1 + c)) / this.bl;
        d -= this.u;
        c = this.y0 + d * this.cosaz - e * this.sinaz;
        a.x = this.x0 + e * this.cosaz + d * this.sinaz;
        a.y = c;
        return a
    }, inverse: function(a){
        var c, b, d, e;
        a.x -= this.x0;
        a.y -= this.y0;
        c = a.x * this.cosaz - a.y * this.sinaz;
        d = a.y * this.cosaz + a.x * this.sinaz;
        d += this.u;
        b = Math.exp(-this.bl * c / this.al);
        c = 0.5 * (b - 1 / b);
        b = 0.5 * (b + 1 / b);
        d = Math.sin(this.bl * d / this.al);
        e = (d * this.cosgam + c * this.singam) / b;
        Math.abs(Math.abs(e) - 1) <= Proj4js.common.EPSLN? (c = this.longc, e = 0 <= e? Proj4js.common.HALF_PI : -Proj4js.common.HALF_PI) :
            (b = 1 / this.bl, e = Math.pow(this.el / Math.sqrt((1 + e) / (1 - e)), b), e = Proj4js.common.phi2z(this.e, e), c = this.longc - Math.atan2(c * this.cosgam - d * this.singam, b) / this.bl, c = Proj4js.common.adjust_lon(c));
        a.x = c;
        a.y = e;
        return a
    }
};
Proj4js.Proj.lcc = {
    init      : function(){
        this.lat2 || (this.lat2 = this.lat0);
        this.k0 || (this.k0 = 1);
        if(Math.abs(this.lat1 + this.lat2) < Proj4js.common.EPSLN) Proj4js.reportError("lcc:init: Equal Latitudes");
        else
        {
            var a = this.b / this.a;
            this.e = Math.sqrt(1 - a * a);
            var a = Math.sin(this.lat1), c = Math.cos(this.lat1), c = Proj4js.common.msfnz(this.e, a, c),
                b = Proj4js.common.tsfnz(this.e, this.lat1, a), d = Math.sin(this.lat2), e = Math.cos(this.lat2),
                e = Proj4js.common.msfnz(this.e, d, e), d = Proj4js.common.tsfnz(this.e, this.lat2, d),
                f = Proj4js.common.tsfnz(this.e,
                    this.lat0, Math.sin(this.lat0));
            this.ns = Math.abs(this.lat1 - this.lat2) > Proj4js.common.EPSLN? Math.log(c / e) / Math.log(b / d) : a;
            this.f0 = c / (this.ns * Math.pow(b, this.ns));
            this.rh = this.a * this.f0 * Math.pow(f, this.ns);
            this.title || (this.title = "Lambert Conformal Conic")
        }
    }, forward: function(a){
        var c = a.x, b = a.y;
        if(!(90 >= b && -90 <= b && 180 >= c && -180 <= c)) return Proj4js.reportError("lcc:forward: llInputOutOfRange: " + c + " : " + b), null;
        var d = Math.abs(Math.abs(b) - Proj4js.common.HALF_PI);
        if(d > Proj4js.common.EPSLN) b = Proj4js.common.tsfnz(this.e,
            b, Math.sin(b)), b = this.a * this.f0 * Math.pow(b, this.ns);
        else
        {
            d = b * this.ns;
            if(0 >= d) return Proj4js.reportError("lcc:forward: No Projection"), null;
            b = 0
        }
        c = this.ns * Proj4js.common.adjust_lon(c - this.long0);
        a.x = this.k0 * b * Math.sin(c) + this.x0;
        a.y = this.k0 * (this.rh - b * Math.cos(c)) + this.y0;
        return a
    }, inverse: function(a){
        var c, b, d, e = (a.x - this.x0) / this.k0, f = this.rh - (a.y - this.y0) / this.k0;
        0 < this.ns? (c = Math.sqrt(e * e + f * f), b = 1) : (c = -Math.sqrt(e * e + f * f), b = -1);
        d = 0;
        0 != c && (d = Math.atan2(b * e, b * f));
        if(0 != c || 0 < this.ns)
        {
            if(b = 1 / this.ns,
                    c = Math.pow(c / (this.a * this.f0), b), c = Proj4js.common.phi2z(this.e, c), -9999 == c) return null
        }
        else c = -Proj4js.common.HALF_PI;
        d = Proj4js.common.adjust_lon(d / this.ns + this.long0);
        a.x = d;
        a.y = c;
        return a
    }
};
Proj4js.Proj.laea = {
    S_POLE : 1,
    N_POLE : 2,
    EQUIT  : 3,
    OBLIQ  : 4,
    init   : function(){
        var a = Math.abs(this.lat0);
        this.mode = Math.abs(a - Proj4js.common.HALF_PI) < Proj4js.common.EPSLN? 0 > this.lat0? this.S_POLE : this.N_POLE : Math.abs(a) < Proj4js.common.EPSLN? this.EQUIT : this.OBLIQ;
        if(0 < this.es) switch(this.qp = Proj4js.common.qsfnz(this.e, 1), this.mmf = 0.5 / (1 - this.es), this.apa = this.authset(this.es), this.mode)
        {
            case this.N_POLE:
            case this.S_POLE:
                this.dd = 1;
                break;
            case this.EQUIT:
                this.rq = Math.sqrt(0.5 * this.qp);
                this.dd = 1 / this.rq;
                this.xmf =
                    1;
                this.ymf = 0.5 * this.qp;
                break;
            case this.OBLIQ:
                this.rq = Math.sqrt(0.5 * this.qp), a = Math.sin(this.lat0), this.sinb1 = Proj4js.common.qsfnz(this.e, a) / this.qp, this.cosb1 = Math.sqrt(1 - this.sinb1 * this.sinb1), this.dd = Math.cos(this.lat0) / (Math.sqrt(1 - this.es * a * a) * this.rq * this.cosb1), this.ymf = (this.xmf = this.rq) / this.dd, this.xmf *= this.dd
        }
        else this.mode == this.OBLIQ && (this.sinph0 = Math.sin(this.lat0), this.cosph0 = Math.cos(this.lat0))
    },
    forward: function(a){
        var c, b, d = a.x, e = a.y, d = Proj4js.common.adjust_lon(d - this.long0);
        if(this.sphere)
        {
            var f,
                g, i;
            i = Math.sin(e);
            g = Math.cos(e);
            f = Math.cos(d);
            switch(this.mode)
            {
                case this.OBLIQ:
                case this.EQUIT:
                    b = this.mode == this.EQUIT? 1 + g * f : 1 + this.sinph0 * i + this.cosph0 * g * f;
                    if(b <= Proj4js.common.EPSLN) return Proj4js.reportError("laea:fwd:y less than eps"), null;
                    b = Math.sqrt(2 / b);
                    c = b * g * Math.sin(d);
                    b *= this.mode == this.EQUIT? i : this.cosph0 * i - this.sinph0 * g * f;
                    break;
                case this.N_POLE:
                    f = -f;
                case this.S_POLE:
                    if(Math.abs(e + this.phi0) < Proj4js.common.EPSLN) return Proj4js.reportError("laea:fwd:phi < eps"), null;
                    b = Proj4js.common.FORTPI -
                        0.5 * e;
                    b = 2 * (this.mode == this.S_POLE? Math.cos(b) : Math.sin(b));
                    c = b * Math.sin(d);
                    b *= f
            }
        }
        else
        {
            var h = g = 0, j = 0;
            f = Math.cos(d);
            d = Math.sin(d);
            i = Math.sin(e);
            i = Proj4js.common.qsfnz(this.e, i);
            if(this.mode == this.OBLIQ || this.mode == this.EQUIT) g = i / this.qp, h = Math.sqrt(1 - g * g);
            switch(this.mode)
            {
                case this.OBLIQ:
                    j = 1 + this.sinb1 * g + this.cosb1 * h * f;
                    break;
                case this.EQUIT:
                    j = 1 + h * f;
                    break;
                case this.N_POLE:
                    j = Proj4js.common.HALF_PI + e;
                    i = this.qp - i;
                    break;
                case this.S_POLE:
                    j = e - Proj4js.common.HALF_PI, i = this.qp + i
            }
            if(Math.abs(j) < Proj4js.common.EPSLN) return Proj4js.reportError("laea:fwd:b < eps"),
                null;
            switch(this.mode)
            {
                case this.OBLIQ:
                case this.EQUIT:
                    j = Math.sqrt(2 / j);
                    b = this.mode == this.OBLIQ? this.ymf * j * (this.cosb1 * g - this.sinb1 * h * f) : (j = Math.sqrt(2 / (1 + h * f))) * g * this.ymf;
                    c = this.xmf * j * h * d;
                    break;
                case this.N_POLE:
                case this.S_POLE:
                    0 <= i? (c = (j = Math.sqrt(i)) * d, b = f * (this.mode == this.S_POLE? j : -j)) : c = b = 0
            }
        }
        a.x = this.a * c + this.x0;
        a.y = this.a * b + this.y0;
        return a
    },
    inverse: function(a){
        a.x -= this.x0;
        a.y -= this.y0;
        var c = a.x / this.a, b = a.y / this.a, d;
        if(this.sphere)
        {
            var e = 0, f, g = 0;
            f = Math.sqrt(c * c + b * b);
            d = 0.5 * f;
            if(1 < d) return Proj4js.reportError("laea:Inv:DataError"),
                null;
            d = 2 * Math.asin(d);
            if(this.mode == this.OBLIQ || this.mode == this.EQUIT) g = Math.sin(d), e = Math.cos(d);
            switch(this.mode)
            {
                case this.EQUIT:
                    d = Math.abs(f) <= Proj4js.common.EPSLN? 0 : Math.asin(b * g / f);
                    c *= g;
                    b = e * f;
                    break;
                case this.OBLIQ:
                    d = Math.abs(f) <= Proj4js.common.EPSLN? this.phi0 : Math.asin(e * this.sinph0 + b * g * this.cosph0 / f);
                    c *= g * this.cosph0;
                    b = (e - Math.sin(d) * this.sinph0) * f;
                    break;
                case this.N_POLE:
                    b = -b;
                    d = Proj4js.common.HALF_PI - d;
                    break;
                case this.S_POLE:
                    d -= Proj4js.common.HALF_PI
            }
            c = 0 == b && (this.mode == this.EQUIT || this.mode ==
                this.OBLIQ)? 0 : Math.atan2(c, b)
        }
        else
        {
            d = 0;
            switch(this.mode)
            {
                case this.EQUIT:
                case this.OBLIQ:
                    c /= this.dd;
                    b *= this.dd;
                    g = Math.sqrt(c * c + b * b);
                    if(g < Proj4js.common.EPSLN) return a.x = 0, a.y = this.phi0, a;
                    f = 2 * Math.asin(0.5 * g / this.rq);
                    e = Math.cos(f);
                    c *= f = Math.sin(f);
                    this.mode == this.OBLIQ? (d = e * this.sinb1 + b * f * this.cosb1 / g, b = g * this.cosb1 * e - b * this.sinb1 * f) : (d = b * f / g, b = g * e);
                    break;
                case this.N_POLE:
                    b = -b;
                case this.S_POLE:
                    d = c * c + b * b;
                    if(!d) return a.x = 0, a.y = this.phi0, a;
                    d = 1 - d / this.qp;
                    this.mode == this.S_POLE && (d = -d)
            }
            c = Math.atan2(c,
                b);
            d = this.authlat(Math.asin(d), this.apa)
        }
        a.x = Proj4js.common.adjust_lon(this.long0 + c);
        a.y = d;
        return a
    },
    P00    : 0.3333333333333333,
    P01    : 0.17222222222222222,
    P02    : 0.10257936507936508,
    P10    : 0.06388888888888888,
    P11    : 0.0664021164021164,
    P20    : 0.016415012942191543,
    authset: function(a){
        var c, b = [];
        b[0] = a * this.P00;
        c = a * a;
        b[0] += c * this.P01;
        b[1] = c * this.P10;
        c *= a;
        b[0] += c * this.P02;
        b[1] += c * this.P11;
        b[2] = c * this.P20;
        return b
    },
    authlat: function(a, c){
        var b = a + a;
        return a + c[0] * Math.sin(b) + c[1] * Math.sin(b + b) + c[2] * Math.sin(b + b + b)
    }
};
Proj4js.Proj.aeqd = {
    init      : function(){
        this.sin_p12 = Math.sin(this.lat0);
        this.cos_p12 = Math.cos(this.lat0)
    }, forward: function(a){
        var c = a.x, b, d = Math.sin(a.y), e = Math.cos(a.y), c = Proj4js.common.adjust_lon(c - this.long0),
            f = Math.cos(c), g = this.sin_p12 * d + this.cos_p12 * e * f;
        if(Math.abs(Math.abs(g) - 1) < Proj4js.common.EPSLN)
        {
            if(b = 1, 0 > g)
            {
                Proj4js.reportError("aeqd:Fwd:PointError");
                return
            }
        }
        else b = Math.acos(g), b /= Math.sin(b);
        a.x = this.x0 + this.a * b * e * Math.sin(c);
        a.y = this.y0 + this.a * b * (this.cos_p12 * d - this.sin_p12 * e * f);
        return a
    },
    inverse   : function(a){
        a.x -= this.x0;
        a.y -= this.y0;
        var c = Math.sqrt(a.x * a.x + a.y * a.y);
        if(c > 2 * Proj4js.common.HALF_PI * this.a) Proj4js.reportError("aeqdInvDataError");
        else
        {
            var b = c / this.a, d = Math.sin(b), b = Math.cos(b), e = this.long0, f;
            if(Math.abs(c) <= Proj4js.common.EPSLN) f = this.lat0;
            else
            {
                f = Proj4js.common.asinz(b * this.sin_p12 + a.y * d * this.cos_p12 / c);
                var g = Math.abs(this.lat0) - Proj4js.common.HALF_PI;
                Math.abs(g) <= Proj4js.common.EPSLN? e = 0 <= this.lat0? Proj4js.common.adjust_lon(this.long0 + Math.atan2(a.x, -a.y)) : Proj4js.common.adjust_lon(this.long0 -
                    Math.atan2(-a.x, a.y)) : (g = b - this.sin_p12 * Math.sin(f), Math.abs(g) < Proj4js.common.EPSLN && Math.abs(a.x) < Proj4js.common.EPSLN || (Math.atan2(a.x * d * this.cos_p12, g * c), e = Proj4js.common.adjust_lon(this.long0 + Math.atan2(a.x * d * this.cos_p12, g * c))))
            }
            a.x = e;
            a.y = f;
            return a
        }
    }
};
Proj4js.Proj.moll = {
    init      : function(){
    }, forward: function(a){
        for(var c = a.y, b = Proj4js.common.adjust_lon(a.x - this.long0), d = c, e = Proj4js.common.PI * Math.sin(c), f = 0 ; ; f++)
        {
            var g = -(d + Math.sin(d) - e) / (1 + Math.cos(d)), d = d + g;
            if(Math.abs(g) < Proj4js.common.EPSLN) break;
            50 <= f && Proj4js.reportError("moll:Fwd:IterationError")
        }
        d /= 2;
        Proj4js.common.PI / 2 - Math.abs(c) < Proj4js.common.EPSLN && (b = 0);
        c = 0.900316316158 * this.a * b * Math.cos(d) + this.x0;
        d = 1.4142135623731 * this.a * Math.sin(d) + this.y0;
        a.x = c;
        a.y = d;
        return a
    }, inverse: function(a){
        var c;
        a.x -= this.x0;
        c = a.y / (1.4142135623731 * this.a);
        0.999999999999 < Math.abs(c) && (c = 0.999999999999);
        c = Math.asin(c);
        var b = Proj4js.common.adjust_lon(this.long0 + a.x / (0.900316316158 * this.a * Math.cos(c)));
        b < -Proj4js.common.PI && (b = -Proj4js.common.PI);
        b > Proj4js.common.PI && (b = Proj4js.common.PI);
        c = (2 * c + Math.sin(2 * c)) / Proj4js.common.PI;
        1 < Math.abs(c) && (c = 1);
        c = Math.asin(c);
        a.x = b;
        a.y = c;
        return a
    }
};

var proj4;

//Proj4 version 2
!function(a){
    if("object" == typeof exports) module.exports = a();
    else if("function" == typeof define && define.amd) define(a);
    else
    {
        var b;
        "undefined" != typeof window? b = window : "undefined" != typeof global? b = global : "undefined" != typeof self && (b = self), b.proj4 = a()
    }
}(function(){
    return function a(b, c, d){
        function e(g, h)
        {
            if(!c[g])
            {
                if(!b[g])
                {
                    var i = "function" == typeof require && require;
                    if(!h && i) return i(g, !0);
                    if(f) return f(g, !0);
                    throw new Error("Cannot find module '" + g + "'")
                }
                var j = c[g] = {exports: {}};
                b[g][0].call(j.exports, function(a){
                    var c = b[g][1][a];
                    return e(c? c : a)
                }, j, j.exports, a, b, c, d)
            }
            return c[g].exports
        }

        for(var f = "function" == typeof require && require, g = 0 ; g < d.length ; g++) e(d[g]);
        return e
    }({
        1                      : [function(a, b){
            function Point(a, b, c)
            {
                if(!(this instanceof Point)) return new Point(a, b, c);
                if(Array.isArray(a)) this.x = a[0], this.y = a[1], this.z = a[2] || 0;
                else if("object" == typeof a) this.x = a.x, this.y = a.y, this.z = a.z || 0;
                else if("string" == typeof a && "undefined" == typeof b)
                {
                    var d = a.split(",");
                    this.x = parseFloat(d[0], 10), this.y = parseFloat(d[1], 10), this.z = parseFloat(d[2], 10) || 0
                }
                else this.x = a, this.y = b, this.z = c || 0;
                console.warn("proj4.Point will be removed in version 3, use proj4.toPoint")
            }

            var c = a("mgrs");
            Point.fromMGRS = function(a){
                return new Point(c.toPoint(a))
            }, Point.prototype.toMGRS = function(a){
                return c.forward([this.x, this.y], a)
            }, b.exports = Point
        }, {mgrs: 66}],
        2                      : [function(a, b){
            function Projection(a, b)
            {
                if(!(this instanceof Projection)) return new Projection(a);
                b = b || function(a){
                    if(a) throw a
                };
                var e = c(a);
                if("object" != typeof e) return void b(a);
                var g = f(e), h = Projection.projections.get(g.projName);
                h? (d(this, g), d(this, h), this.init(), b(null, this)) : b(a)
            }

            var c = a("./parseCode"), d = a("./extend"), e = a("./projections"), f = a("./deriveConstants");
            Projection.projections = e, Projection.projections.start(), b.exports = Projection
        }, {"./deriveConstants": 32, "./extend": 33, "./parseCode": 36, "./projections": 38}],
        3                      : [function(a, b){
            b.exports = function(a, b, c){
                var d, e, f, g = c.x, h = c.y, i = c.z || 0;
                for(f = 0 ; 3 > f ; f++) if(!b || 2 !== f || void 0 !== c.z) switch(0 === f? (d = g, e = "x") : 1 === f? (d = h, e = "y") : (d = i, e = "z"), a.axis[f])
                {
                    case"e":
                        c[e] = d;
                        break;
                    case"w":
                        c[e] = -d;
                        break;
                    case"n":
                        c[e] = d;
                        break;
                    case"s":
                        c[e] = -d;
                        break;
                    case"u":
                        void 0 !== c[e] && (c.z = d);
                        break;
                    case"d":
                        void 0 !== c[e] && (c.z = -d);
                        break;
                    default:
                        return null
                }
                return c
            }
        }, {}],
        4                      : [function(a, b){
            var c = Math.PI / 2, d = a("./sign");
            b.exports = function(a){
                return Math.abs(a) < c? a : a - d(a) * Math.PI
            }
        }, {"./sign": 21}],
        5                      : [function(a, b){
            var c = 2 * Math.PI, d = 3.14159265359, e = a("./sign");
            b.exports = function(a){
                return Math.abs(a) <= d? a : a - e(a) * c
            }
        }, {"./sign": 21}],
        6                      : [function(a, b){
            b.exports = function(a){
                return Math.abs(a) > 1 && (a = a > 1? 1 : -1), Math.asin(a)
            }
        }, {}],
        7                      : [function(a, b){
            b.exports = function(a){
                return 1 - .25 * a * (1 + a / 16 * (3 + 1.25 * a))
            }
        }, {}],
        8                      : [function(a, b){
            b.exports = function(a){
                return .375 * a * (1 + .25 * a * (1 + .46875 * a))
            }
        }, {}],
        9                      : [function(a, b){
            b.exports = function(a){
                return .05859375 * a * a * (1 + .75 * a)
            }
        }, {}],
        10                     : [function(a, b){
            b.exports = function(a){
                return a * a * a * (35 / 3072)
            }
        }, {}],
        11                     : [function(a, b){
            b.exports = function(a, b, c){
                var d = b * c;
                return a / Math.sqrt(1 - d * d)
            }
        }, {}],
        12                     : [function(a, b){
            b.exports = function(a, b, c, d, e){
                var f, g;
                f = a / b;
                for(var h = 0 ; 15 > h ; h++) if(g = (a - (b * f - c * Math.sin(2 * f) + d * Math.sin(4 * f) - e * Math.sin(6 * f))) / (b - 2 * c * Math.cos(2 * f) + 4 * d * Math.cos(4 * f) - 6 * e * Math.cos(6 * f)), f += g, Math.abs(g) <= 1e-10) return f;
                return 0 / 0
            }
        }, {}],
        13                     : [function(a, b){
            var c = Math.PI / 2;
            b.exports = function(a, b){
                var d = 1 - (1 - a * a) / (2 * a) * Math.log((1 - a) / (1 + a));
                if(Math.abs(Math.abs(b) - d) < 1e-6) return 0 > b? -1 * c : c;
                for(var e, f, g, h, i = Math.asin(.5 * b), j = 0 ; 30 > j ; j++) if(f = Math.sin(i), g = Math.cos(i), h = a * f, e = Math.pow(1 - h * h, 2) / (2 * g) * (b / (1 - a * a) - f / (1 - h * h) + .5 / a * Math.log((1 - h) / (1 + h))), i += e, Math.abs(e) <= 1e-10) return i;
                return 0 / 0
            }
        }, {}],
        14                     : [function(a, b){
            b.exports = function(a, b, c, d, e){
                return a * e - b * Math.sin(2 * e) + c * Math.sin(4 * e) - d * Math.sin(6 * e)
            }
        }, {}],
        15                     : [function(a, b){
            b.exports = function(a, b, c){
                var d = a * b;
                return c / Math.sqrt(1 - d * d)
            }
        }, {}],
        16                     : [function(a, b){
            var c = Math.PI / 2;
            b.exports = function(a, b){
                for(var d, e, f = .5 * a, g = c - 2 * Math.atan(b), h = 0 ; 15 >= h ; h++) if(d = a * Math.sin(g), e = c - 2 * Math.atan(b * Math.pow((1 - d) / (1 + d), f)) - g, g += e, Math.abs(e) <= 1e-10) return g;
                return -9999
            }
        }, {}],
        17                     : [function(a, b){
            var c = 1, d = .25, e = .046875, f = .01953125, g = .01068115234375, h = .75, i = .46875,
                j = .013020833333333334, k = .007120768229166667, l = .3645833333333333, m = .005696614583333333,
                n = .3076171875;
            b.exports = function(a){
                var b = [];
                b[0] = c - a * (d + a * (e + a * (f + a * g))), b[1] = a * (h - a * (e + a * (f + a * g)));
                var o = a * a;
                return b[2] = o * (i - a * (j + a * k)), o *= a, b[3] = o * (l - a * m), b[4] = o * a * n, b
            }
        }, {}],
        18                     : [function(a, b){
            var c = a("./pj_mlfn"), d = 1e-10, e = 20;
            b.exports = function(a, b, f){
                for(var g = 1 / (1 - b), h = a, i = e ; i ; --i)
                {
                    var j = Math.sin(h), k = 1 - b * j * j;
                    if(k = (c(h, j, Math.cos(h), f) - a) * k * Math.sqrt(k) * g, h -= k, Math.abs(k) < d) return h
                }
                return h
            }
        }, {"./pj_mlfn": 19}],
        19                     : [function(a, b){
            b.exports = function(a, b, c, d){
                return c *= b, b *= b, d[0] * a - c * (d[1] + b * (d[2] + b * (d[3] + b * d[4])))
            }
        }, {}],
        20                     : [function(a, b){
            b.exports = function(a, b){
                var c;
                return a > 1e-7? (c = a * b, (1 - a * a) * (b / (1 - c * c) - .5 / a * Math.log((1 - c) / (1 + c)))) : 2 * b
            }
        }, {}],
        21                     : [function(a, b){
            b.exports = function(a){
                return 0 > a? -1 : 1
            }
        }, {}],
        22                     : [function(a, b){
            b.exports = function(a, b){
                return Math.pow((1 - a) / (1 + a), b)
            }
        }, {}],
        23                     : [function(a, b){
            b.exports = function(a){
                var b = {x: a[0], y: a[1]};
                return a.length > 2 && (b.z = a[2]), a.length > 3 && (b.m = a[3]), b
            }
        }, {}],
        24                     : [function(a, b){
            var c = Math.PI / 2;
            b.exports = function(a, b, d){
                var e = a * d, f = .5 * a;
                return e = Math.pow((1 - e) / (1 + e), f), Math.tan(.5 * (c - b)) / e
            }
        }, {}],
        25                     : [function(a, b, c){
            c.wgs84 = {
                towgs84  : "0,0,0",
                ellipse  : "WGS84",
                datumName: "WGS84"
            }, c.ch1903 = {
                towgs84  : "674.374,15.056,405.346",
                ellipse  : "bessel",
                datumName: "swiss"
            }, c.ggrs87 = {
                towgs84  : "-199.87,74.79,246.62",
                ellipse  : "GRS80",
                datumName: "Greek_Geodetic_Reference_System_1987"
            }, c.nad83 = {
                towgs84  : "0,0,0",
                ellipse  : "GRS80",
                datumName: "North_American_Datum_1983"
            }, c.nad27 = {
                nadgrids : "@conus,@alaska,@ntv2_0.gsb,@ntv1_can.dat",
                ellipse  : "clrk66",
                datumName: "North_American_Datum_1927"
            }, c.potsdam = {
                towgs84  : "606.0,23.0,413.0",
                ellipse  : "bessel",
                datumName: "Potsdam Rauenberg 1950 DHDN"
            }, c.carthage = {
                towgs84  : "-263.0,6.0,431.0",
                ellipse  : "clark80",
                datumName: "Carthage 1934 Tunisia"
            }, c.hermannskogel = {
                towgs84  : "653.0,-212.0,449.0",
                ellipse  : "bessel",
                datumName: "Hermannskogel"
            }, c.ire65 = {
                towgs84  : "482.530,-130.596,564.557,-1.042,-0.214,-0.631,8.15",
                ellipse  : "mod_airy",
                datumName: "Ireland 1965"
            }, c.rassadiran = {
                towgs84  : "-133.63,-157.5,-158.62",
                ellipse  : "intl",
                datumName: "Rassadiran"
            }, c.nzgd49 = {
                towgs84  : "59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993",
                ellipse  : "intl",
                datumName: "New Zealand Geodetic Datum 1949"
            }, c.osgb36 = {
                towgs84  : "446.448,-125.157,542.060,0.1502,0.2470,0.8421,-20.4894",
                ellipse  : "airy",
                datumName: "Airy 1830"
            }, c.s_jtsk = {
                towgs84  : "589,76,480",
                ellipse  : "bessel",
                datumName: "S-JTSK (Ferro)"
            }, c.beduaram = {
                towgs84  : "-106,-87,188",
                ellipse  : "clrk80",
                datumName: "Beduaram"
            }, c.gunung_segara = {
                towgs84  : "-403,684,41",
                ellipse  : "bessel",
                datumName: "Gunung Segara Jakarta"
            }, c.rnb72 = {
                towgs84  : "106.869,-52.2978,103.724,-0.33657,0.456955,-1.84218,1",
                ellipse  : "intl",
                datumName: "Reseau National Belge 1972"
            }
        }, {}],
        26                     : [function(a, b, c){
            c.MERIT = {a: 6378137, rf: 298.257, ellipseName: "MERIT 1983"}, c.SGS85 = {
                a          : 6378136,
                rf         : 298.257,
                ellipseName: "Soviet Geodetic System 85"
            }, c.GRS80 = {a: 6378137, rf: 298.257222101, ellipseName: "GRS 1980(IUGG, 1980)"}, c.IAU76 = {
                a          : 6378140,
                rf         : 298.257,
                ellipseName: "IAU 1976"
            }, c.airy = {a: 6377563.396, b: 6356256.91, ellipseName: "Airy 1830"}, c.APL4 = {
                a          : 6378137,
                rf         : 298.25,
                ellipseName: "Appl. Physics. 1965"
            }, c.NWL9D = {
                a          : 6378145,
                rf         : 298.25,
                ellipseName: "Naval Weapons Lab., 1965"
            }, c.mod_airy = {a: 6377340.189, b: 6356034.446, ellipseName: "Modified Airy"}, c.andrae = {
                a          : 6377104.43,
                rf         : 300,
                ellipseName: "Andrae 1876 (Den., Iclnd.)"
            }, c.aust_SA = {
                a          : 6378160,
                rf         : 298.25,
                ellipseName: "Australian Natl & S. Amer. 1969"
            }, c.GRS67 = {a: 6378160, rf: 298.247167427, ellipseName: "GRS 67(IUGG 1967)"}, c.bessel = {
                a          : 6377397.155,
                rf         : 299.1528128,
                ellipseName: "Bessel 1841"
            }, c.bess_nam = {
                a          : 6377483.865,
                rf         : 299.1528128,
                ellipseName: "Bessel 1841 (Namibia)"
            }, c.clrk66 = {a: 6378206.4, b: 6356583.8, ellipseName: "Clarke 1866"}, c.clrk80 = {
                a          : 6378249.145,
                rf         : 293.4663,
                ellipseName: "Clarke 1880 mod."
            }, c.clrk58 = {
                a          : 6378293.645208759,
                rf         : 294.2606763692654,
                ellipseName: "Clarke 1858"
            }, c.CPM = {
                a          : 6375738.7,
                rf         : 334.29,
                ellipseName: "Comm. des Poids et Mesures 1799"
            }, c.delmbr = {a: 6376428, rf: 311.5, ellipseName: "Delambre 1810 (Belgium)"}, c.engelis = {
                a          : 6378136.05,
                rf         : 298.2566,
                ellipseName: "Engelis 1985"
            }, c.evrst30 = {a: 6377276.345, rf: 300.8017, ellipseName: "Everest 1830"}, c.evrst48 = {
                a          : 6377304.063,
                rf         : 300.8017,
                ellipseName: "Everest 1948"
            }, c.evrst56 = {a: 6377301.243, rf: 300.8017, ellipseName: "Everest 1956"}, c.evrst69 = {
                a          : 6377295.664,
                rf         : 300.8017,
                ellipseName: "Everest 1969"
            }, c.evrstSS = {
                a          : 6377298.556,
                rf         : 300.8017,
                ellipseName: "Everest (Sabah & Sarawak)"
            }, c.fschr60 = {
                a          : 6378166,
                rf         : 298.3,
                ellipseName: "Fischer (Mercury Datum) 1960"
            }, c.fschr60m = {a: 6378155, rf: 298.3, ellipseName: "Fischer 1960"}, c.fschr68 = {
                a          : 6378150,
                rf         : 298.3,
                ellipseName: "Fischer 1968"
            }, c.helmert = {a: 6378200, rf: 298.3, ellipseName: "Helmert 1906"}, c.hough = {
                a          : 6378270,
                rf         : 297,
                ellipseName: "Hough"
            }, c.intl = {a: 6378388, rf: 297, ellipseName: "International 1909 (Hayford)"}, c.kaula = {
                a          : 6378163,
                rf         : 298.24,
                ellipseName: "Kaula 1961"
            }, c.lerch = {a: 6378139, rf: 298.257, ellipseName: "Lerch 1979"}, c.mprts = {
                a          : 6397300,
                rf         : 191,
                ellipseName: "Maupertius 1738"
            }, c.new_intl = {
                a          : 6378157.5,
                b          : 6356772.2,
                ellipseName: "New International 1967"
            }, c.plessis = {a: 6376523, rf: 6355863, ellipseName: "Plessis 1817 (France)"}, c.krass = {
                a          : 6378245,
                rf         : 298.3,
                ellipseName: "Krassovsky, 1942"
            }, c.SEasia = {a: 6378155, b: 6356773.3205, ellipseName: "Southeast Asia"}, c.walbeck = {
                a          : 6376896,
                b          : 6355834.8467,
                ellipseName: "Walbeck"
            }, c.WGS60 = {a: 6378165, rf: 298.3, ellipseName: "WGS 60"}, c.WGS66 = {
                a          : 6378145,
                rf         : 298.25,
                ellipseName: "WGS 66"
            }, c.WGS7 = {a: 6378135, rf: 298.26, ellipseName: "WGS 72"}, c.WGS84 = {
                a          : 6378137,
                rf         : 298.257223563,
                ellipseName: "WGS 84"
            }, c.sphere = {a: 6370997, b: 6370997, ellipseName: "Normal Sphere (r=6370997)"}
        }, {}],
        27                     : [function(a, b, c){
            c.greenwich = 0, c.lisbon = -9.131906111111, c.paris = 2.337229166667, c.bogota = -74.080916666667, c.madrid = -3.687938888889, c.rome = 12.452333333333, c.bern = 7.439583333333, c.jakarta = 106.807719444444, c.ferro = -17.666666666667, c.brussels = 4.367975, c.stockholm = 18.058277777778, c.athens = 23.7163375, c.oslo = 10.722916666667
        }, {}],
        28                     : [function(a, b){
            function c(a, b, c)
            {
                var d;
                return Array.isArray(c)? (d = f(a, b, c), 3 === c.length? [d.x, d.y, d.z] : [d.x, d.y]) : f(a, b, c)
            }

            function d(a)
            {
                return a instanceof e? a : a.oProj? a.oProj : e(a)
            }

            function proj4(a, b, e)
            {
                a = d(a);
                var f, h = !1;
                return "undefined" == typeof b? (b = a, a = g, h = !0) : ("undefined" != typeof b.x || Array.isArray(b)) && (e = b, b = a, a = g, h = !0), b = d(b), e? c(a, b, e) : (f = {
                    forward: function(d){
                        return c(a, b, d)
                    },
                    inverse: function(d){
                        return c(b, a, d)
                    }
                }, h && (f.oProj = b), f)
            }

            var e = a("./Proj"), f = a("./transform"), g = e("WGS84");
            b.exports = proj4
        }, {"./Proj": 2, "./transform": 64}],
        29                     : [function(a, b){
            var c = Math.PI / 2, d = 1, e = 2, f = 3, g = 4, h = 5, i = 484813681109536e-20, j = 1.0026,
                k = .3826834323650898, l = function(a){
                    if(!(this instanceof l)) return new l(a);
                    if(this.datum_type = g, a)
                    {
                        if(a.datumCode && "none" === a.datumCode && (this.datum_type = h), a.datum_params)
                        {
                            for(var b = 0 ; b < a.datum_params.length ; b++) a.datum_params[b] = parseFloat(a.datum_params[b]);
                            (0 !== a.datum_params[0] || 0 !== a.datum_params[1] || 0 !== a.datum_params[2]) && (this.datum_type = d), a.datum_params.length > 3 && (0 !== a.datum_params[3] || 0 !== a.datum_params[4] || 0 !== a.datum_params[5] || 0 !== a.datum_params[6]) && (this.datum_type = e, a.datum_params[3] *= i, a.datum_params[4] *= i, a.datum_params[5] *= i, a.datum_params[6] = a.datum_params[6] / 1e6 + 1)
                        }
                        this.datum_type = a.grids? f : this.datum_type, this.a = a.a, this.b = a.b, this.es = a.es, this.ep2 = a.ep2, this.datum_params = a.datum_params, this.datum_type === f && (this.grids = a.grids)
                    }
                };
            l.prototype = {
                compare_datums                   : function(a){
                    return this.datum_type !== a.datum_type? !1 : this.a !== a.a || Math.abs(this.es - a.es) > 5e-11? !1 : this.datum_type === d? this.datum_params[0] === a.datum_params[0] && this.datum_params[1] === a.datum_params[1] && this.datum_params[2] === a.datum_params[2] : this.datum_type === e? this.datum_params[0] === a.datum_params[0] && this.datum_params[1] === a.datum_params[1] && this.datum_params[2] === a.datum_params[2] && this.datum_params[3] === a.datum_params[3] && this.datum_params[4] === a.datum_params[4] && this.datum_params[5] === a.datum_params[5] && this.datum_params[6] === a.datum_params[6] : this.datum_type === f || a.datum_type === f? this.nadgrids === a.nadgrids : !0
                }, geodetic_to_geocentric        : function(a){
                    var b, d, e, f, g, h, i, j = a.x, k = a.y, l = a.z? a.z : 0, m = 0;
                    if(-c > k && k > -1.001 * c) k = -c;
                    else if(k > c && 1.001 * c > k) k = c;
                    else if(-c > k || k > c) return null;
                    return j > Math.PI && (j -= 2 * Math.PI), g = Math.sin(k), i = Math.cos(k), h = g * g, f = this.a / Math.sqrt(1 - this.es * h), b = (f + l) * i * Math.cos(j), d = (f + l) * i * Math.sin(j), e = (f * (1 - this.es) + l) * g, a.x = b, a.y = d, a.z = e, m
                }, geocentric_to_geodetic        : function(a){
                    var b, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t = 1e-12, u = t * t, v = 30, w = a.x,
                        x = a.y, y = a.z? a.z : 0;
                    if(o = !1, b = Math.sqrt(w * w + x * x), d = Math.sqrt(w * w + x * x + y * y), b / this.a < t)
                    {
                        if(o = !0, q = 0, d / this.a < t) return r = c, void(s = -this.b)
                    }
                    else q = Math.atan2(x, w);
                    e = y / d, f = b / d, g = 1 / Math.sqrt(1 - this.es * (2 - this.es) * f * f), j = f * (1 - this.es) * g, k = e * g, p = 0;
                    do p++, i = this.a / Math.sqrt(1 - this.es * k * k), s = b * j + y * k - i * (1 - this.es * k * k), h = this.es * i / (i + s), g = 1 / Math.sqrt(1 - h * (2 - h) * f * f), l = f * (1 - h) * g, m = e * g, n = m * j - l * k, j = l, k = m;while(n * n > u && v > p);
                    return r = Math.atan(m / Math.abs(l)), a.x = q, a.y = r, a.z = s, a
                }, geocentric_to_geodetic_noniter: function(a){
                    var b, d, e, f, g, h, i, l, m, n, o, p, q, r, s, t, u, v = a.x, w = a.y, x = a.z? a.z : 0;
                    if(v = parseFloat(v), w = parseFloat(w), x = parseFloat(x), u = !1, 0 !== v) b = Math.atan2(w, v);
                    else if(w > 0) b = c;
                    else if(0 > w) b = -c;
                    else if(u = !0, b = 0, x > 0) d = c;
                    else
                    {
                        if(!(0 > x)) return d = c, void(e = -this.b);
                        d = -c
                    }
                    return g = v * v + w * w, f = Math.sqrt(g), h = x * j, l = Math.sqrt(h * h + g), n = h / l, p = f / l, o = n * n * n, i = x + this.b * this.ep2 * o, t = f - this.a * this.es * p * p * p, m = Math.sqrt(i * i + t * t), q = i / m, r = t / m, s = this.a / Math.sqrt(1 - this.es * q * q), e = r >= k? f / r - s : -k >= r? f / -r - s : x / q + s * (this.es - 1), u === !1 && (d = Math.atan(q / r)), a.x = b, a.y = d, a.z = e, a
                }, geocentric_to_wgs84           : function(a){
                    if(this.datum_type === d) a.x += this.datum_params[0], a.y += this.datum_params[1], a.z += this.datum_params[2];
                    else if(this.datum_type === e)
                    {
                        var b = this.datum_params[0], c = this.datum_params[1], f = this.datum_params[2],
                            g = this.datum_params[3], h = this.datum_params[4], i = this.datum_params[5],
                            j = this.datum_params[6], k = j * (a.x - i * a.y + h * a.z) + b,
                            l = j * (i * a.x + a.y - g * a.z) + c, m = j * (-h * a.x + g * a.y + a.z) + f;
                        a.x = k, a.y = l, a.z = m
                    }
                }, geocentric_from_wgs84         : function(a){
                    if(this.datum_type === d) a.x -= this.datum_params[0], a.y -= this.datum_params[1], a.z -= this.datum_params[2];
                    else if(this.datum_type === e)
                    {
                        var b = this.datum_params[0], c = this.datum_params[1], f = this.datum_params[2],
                            g = this.datum_params[3], h = this.datum_params[4], i = this.datum_params[5],
                            j = this.datum_params[6], k = (a.x - b) / j, l = (a.y - c) / j, m = (a.z - f) / j;
                        a.x = k + i * l - h * m, a.y = -i * k + l + g * m, a.z = h * k - g * l + m
                    }
                }
            }, b.exports = l
        }, {}],
        30                     : [function(a, b){
            var c = 1, d = 2, e = 3, f = 5, g = 6378137, h = .006694379990141316;
            b.exports = function(a, b, i){
                function j(a)
                {
                    return a === c || a === d
                }

                var k, l, m;
                if(a.compare_datums(b)) return i;
                if(a.datum_type === f || b.datum_type === f) return i;
                var n = a.a, o = a.es, p = b.a, q = b.es, r = a.datum_type;
                if(r === e) if(0 === this.apply_gridshift(a, 0, i)) a.a = g, a.es = h;
                else
                {
                    if(!a.datum_params) return a.a = n, a.es = a.es, i;
                    for(k = 1, l = 0, m = a.datum_params.length ; m > l ; l++) k *= a.datum_params[l];
                    if(0 === k) return a.a = n, a.es = a.es, i;
                    r = a.datum_params.length > 3? d : c
                }
                return b.datum_type === e && (b.a = g, b.es = h), (a.es !== b.es || a.a !== b.a || j(r) || j(b.datum_type)) && (a.geodetic_to_geocentric(i), j(a.datum_type) && a.geocentric_to_wgs84(i), j(b.datum_type) && b.geocentric_from_wgs84(i), b.geocentric_to_geodetic(i)), b.datum_type === e && this.apply_gridshift(b, 1, i), a.a = n, a.es = o, b.a = p, b.es = q, i
            }
        }, {}],
        31                     : [function(a, b){
            function c(a)
            {
                var b = this;
                if(2 === arguments.length)
                {
                    var d = arguments[1];
                    c[a] = "string" == typeof d? "+" === d.charAt(0)? e(arguments[1]) : f(arguments[1]) : d
                }
                else if(1 === arguments.length)
                {
                    if(Array.isArray(a)) return a.map(function(a){
                        Array.isArray(a)? c.apply(b, a) : c(a)
                    });
                    if("string" == typeof a)
                    {
                        if(a in c) return c[a]
                    }
                    else "EPSG" in a? c["EPSG:" + a.EPSG] = a : "ESRI" in a? c["ESRI:" + a.ESRI] = a : "IAU2000" in a? c["IAU2000:" + a.IAU2000] = a : console.log(a);
                    return
                }
            }

            var d = a("./global"), e = a("./projString"), f = a("./wkt");
            d(c), b.exports = c
        }, {"./global": 34, "./projString": 37, "./wkt": 65}],
        32                     : [function(a, b){
            var c = a("./constants/Datum"), d = a("./constants/Ellipsoid"), e = a("./extend"), f = a("./datum"),
                g = 1e-10, h = .16666666666666666, i = .04722222222222222, j = .022156084656084655;
            b.exports = function(a){
                if(a.datumCode && "none" !== a.datumCode)
                {
                    var b = c[a.datumCode];
                    b && (a.datum_params = b.towgs84? b.towgs84.split(",") : null, a.ellps = b.ellipse, a.datumName = b.datumName? b.datumName : a.datumCode)
                }
                if(!a.a)
                {
                    var k = d[a.ellps]? d[a.ellps] : d.WGS84;
                    e(a, k)
                }
                return a.rf && !a.b && (a.b = (1 - 1 / a.rf) * a.a), (0 === a.rf || Math.abs(a.a - a.b) < g) && (a.sphere = !0, a.b = a.a), a.a2 = a.a * a.a, a.b2 = a.b * a.b, a.es = (a.a2 - a.b2) / a.a2, a.e = Math.sqrt(a.es), a.R_A && (a.a *= 1 - a.es * (h + a.es * (i + a.es * j)), a.a2 = a.a * a.a, a.b2 = a.b * a.b, a.es = 0), a.ep2 = (a.a2 - a.b2) / a.b2, a.k0 || (a.k0 = 1), a.axis || (a.axis = "enu"), a.datum || (a.datum = f(a)), a
            }
        }, {"./constants/Datum": 25, "./constants/Ellipsoid": 26, "./datum": 29, "./extend": 33}],
        33                     : [function(a, b){
            b.exports = function(a, b){
                a = a || {};
                var c, d;
                if(!b) return a;
                for(d in b) c = b[d], void 0 !== c && (a[d] = c);
                return a
            }
        }, {}],
        34                     : [function(a, b){
            b.exports = function(a){
                a("EPSG:4326", "+title=WGS 84 (long/lat) +proj=longlat +ellps=WGS84 +datum=WGS84 +units=degrees"), a("EPSG:4269", "+title=NAD83 (long/lat) +proj=longlat +a=6378137.0 +b=6356752.31414036 +ellps=GRS80 +datum=NAD83 +units=degrees"), a("EPSG:3857", "+title=WGS 84 / Pseudo-Mercator +proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +no_defs"), a.WGS84 = a["EPSG:4326"], a["EPSG:3785"] = a["EPSG:3857"], a.GOOGLE = a["EPSG:3857"], a["EPSG:900913"] = a["EPSG:3857"], a["EPSG:102113"] = a["EPSG:3857"]
            }
        }, {}],
        35                     : [function(a, b){
            var proj4 = a("./core");
            proj4.defaultDatum = "WGS84", proj4.Proj = a("./Proj"), proj4.WGS84 = new proj4.Proj("WGS84"), proj4.Point = a("./Point"), proj4.toPoint = a("./common/toPoint"), proj4.defs = a("./defs"), proj4.transform = a("./transform"), proj4.mgrs = a("mgrs"), proj4.version = a("../package.json").version, a("./includedProjections")(proj4), b.exports = proj4
        }, {
            "../package.json"      : 67,
            "./Point"              : 1,
            "./Proj"               : 2,
            "./common/toPoint"     : 23,
            "./core"               : 28,
            "./defs"               : 31,
            "./includedProjections": "gWUPNW",
            "./transform"          : 64,
            mgrs                   : 66
        }],
        36                     : [function(a, b){
            function c(a)
            {
                return "string" == typeof a
            }

            function d(a)
            {
                return a in h
            }

            function e(a)
            {
                var b = ["GEOGCS", "GEOCCS", "PROJCS", "LOCAL_CS"];
                return b.reduce(function(b, c){
                    return b + 1 + a.indexOf(c)
                }, 0)
            }

            function f(a)
            {
                return "+" === a[0]
            }

            function g(a)
            {
                return c(a)? d(a)? h[a] : e(a)? i(a) : f(a)? j(a) : void 0 : a
            }

            var h = a("./defs"), i = a("./wkt"), j = a("./projString");
            b.exports = g
        }, {"./defs": 31, "./projString": 37, "./wkt": 65}],
        37                     : [function(a, b){
            var c = .017453292519943295, d = a("./constants/PrimeMeridian");
            b.exports = function(a){
                var b = {}, e = {};
                a.split("+").map(function(a){
                    return a.trim()
                }).filter(function(a){
                    return a
                }).forEach(function(a){
                    var b = a.split("=");
                    b.push(!0), e[b[0].toLowerCase()] = b[1]
                });
                var f, g, h, i = {
                    proj             : "projName", datum: "datumCode", rf: function(a){
                        b.rf = parseFloat(a)
                    }, lat_0         : function(a){
                        b.lat0 = a * c
                    }, lat_1         : function(a){
                        b.lat1 = a * c
                    }, lat_2         : function(a){
                        b.lat2 = a * c
                    }, lat_ts        : function(a){
                        b.lat_ts = a * c
                    }, lon_0         : function(a){
                        b.long0 = a * c
                    }, lon_1         : function(a){
                        b.long1 = a * c
                    }, lon_2         : function(a){
                        b.long2 = a * c
                    }, alpha         : function(a){
                        b.alpha = parseFloat(a) * c
                    }, lonc          : function(a){
                        b.longc = a * c
                    }, x_0           : function(a){
                        b.x0 = parseFloat(a)
                    }, y_0           : function(a){
                        b.y0 = parseFloat(a)
                    }, k_0           : function(a){
                        b.k0 = parseFloat(a)
                    }, k             : function(a){
                        b.k0 = parseFloat(a)
                    }, a             : function(a){
                        b.a = parseFloat(a)
                    }, b             : function(a){
                        b.b = parseFloat(a)
                    }, r_a           : function(){
                        b.R_A = !0
                    }, zone          : function(a){
                        b.zone = parseInt(a, 10)
                    }, south         : function(){
                        b.utmSouth = !0
                    }, towgs84       : function(a){
                        b.datum_params = a.split(",").map(function(a){
                            return parseFloat(a)
                        })
                    }, to_meter      : function(a){
                        b.to_meter = parseFloat(a)
                    }, from_greenwich: function(a){
                        b.from_greenwich = a * c
                    }, pm            : function(a){
                        b.from_greenwich = (d[a]? d[a] : parseFloat(a)) * c
                    }, nadgrids      : function(a){
                        "@null" === a? b.datumCode = "none" : b.nadgrids = a
                    }, axis          : function(a){
                        var c = "ewnsud";
                        3 === a.length && -1 !== c.indexOf(a.substr(0, 1)) && -1 !== c.indexOf(a.substr(1, 1)) && -1 !== c.indexOf(a.substr(2, 1)) && (b.axis = a)
                    }
                };
                for(f in e) g = e[f], f in i? (h = i[f], "function" == typeof h? h(g) : b[h] = g) : b[f] = g;
                return "string" == typeof b.datumCode && "WGS84" !== b.datumCode && (b.datumCode = b.datumCode.toLowerCase()), b
            }
        }, {"./constants/PrimeMeridian": 27}],
        38                     : [function(a, b, c){
            function d(a, b)
            {
                var c = g.length;
                return a.names? (g[c] = a, a.names.forEach(function(a){
                    f[a.toLowerCase()] = c
                }), this) : (console.log(b), !0)
            }

            var e = [a("./projections/merc"), a("./projections/longlat")], f = {}, g = [];
            c.add = d, c.get = function(a){
                if(!a) return !1;
                var b = a.toLowerCase();
                return "undefined" != typeof f[b] && g[f[b]]? g[f[b]] : void 0
            }, c.start = function(){
                e.forEach(d)
            }
        }, {"./projections/longlat": 50, "./projections/merc": 51}],
        39                     : [function(a, b, c){
            var d = 1e-10, e = a("../common/msfnz"), f = a("../common/qsfnz"), g = a("../common/adjust_lon"),
                h = a("../common/asinz");
            c.init = function(){
                Math.abs(this.lat1 + this.lat2) < d || (this.temp = this.b / this.a, this.es = 1 - Math.pow(this.temp, 2), this.e3 = Math.sqrt(this.es), this.sin_po = Math.sin(this.lat1), this.cos_po = Math.cos(this.lat1), this.t1 = this.sin_po, this.con = this.sin_po, this.ms1 = e(this.e3, this.sin_po, this.cos_po), this.qs1 = f(this.e3, this.sin_po, this.cos_po), this.sin_po = Math.sin(this.lat2), this.cos_po = Math.cos(this.lat2), this.t2 = this.sin_po, this.ms2 = e(this.e3, this.sin_po, this.cos_po), this.qs2 = f(this.e3, this.sin_po, this.cos_po), this.sin_po = Math.sin(this.lat0), this.cos_po = Math.cos(this.lat0), this.t3 = this.sin_po, this.qs0 = f(this.e3, this.sin_po, this.cos_po), this.ns0 = Math.abs(this.lat1 - this.lat2) > d? (this.ms1 * this.ms1 - this.ms2 * this.ms2) / (this.qs2 - this.qs1) : this.con, this.c = this.ms1 * this.ms1 + this.ns0 * this.qs1, this.rh = this.a * Math.sqrt(this.c - this.ns0 * this.qs0) / this.ns0)
            }, c.forward = function(a){
                var b = a.x, c = a.y;
                this.sin_phi = Math.sin(c), this.cos_phi = Math.cos(c);
                var d = f(this.e3, this.sin_phi, this.cos_phi),
                    e = this.a * Math.sqrt(this.c - this.ns0 * d) / this.ns0, h = this.ns0 * g(b - this.long0),
                    i = e * Math.sin(h) + this.x0, j = this.rh - e * Math.cos(h) + this.y0;
                return a.x = i, a.y = j, a
            }, c.inverse = function(a){
                var b, c, d, e, f, h;
                return a.x -= this.x0, a.y = this.rh - a.y + this.y0, this.ns0 >= 0? (b = Math.sqrt(a.x * a.x + a.y * a.y), d = 1) : (b = -Math.sqrt(a.x * a.x + a.y * a.y), d = -1), e = 0, 0 !== b && (e = Math.atan2(d * a.x, d * a.y)), d = b * this.ns0 / this.a, this.sphere? h = Math.asin((this.c - d * d) / (2 * this.ns0)) : (c = (this.c - d * d) / this.ns0, h = this.phi1z(this.e3, c)), f = g(e / this.ns0 + this.long0), a.x = f, a.y = h, a
            }, c.phi1z = function(a, b){
                var c, e, f, g, i, j = h(.5 * b);
                if(d > a) return j;
                for(var k = a * a, l = 1 ; 25 >= l ; l++) if(c = Math.sin(j), e = Math.cos(j), f = a * c, g = 1 - f * f, i = .5 * g * g / e * (b / (1 - k) - c / g + .5 / a * Math.log((1 - f) / (1 + f))), j += i, Math.abs(i) <= 1e-7) return j;
                return null
            }, c.names = ["Albers_Conic_Equal_Area", "Albers", "aea"]
        }, {"../common/adjust_lon": 5, "../common/asinz": 6, "../common/msfnz": 15, "../common/qsfnz": 20}],
        40                     : [function(a, b, c){
            var d = a("../common/adjust_lon"), e = Math.PI / 2, f = 1e-10, g = a("../common/mlfn"),
                h = a("../common/e0fn"), i = a("../common/e1fn"), j = a("../common/e2fn"), k = a("../common/e3fn"),
                l = a("../common/gN"), m = a("../common/asinz"), n = a("../common/imlfn");
            c.init = function(){
                this.sin_p12 = Math.sin(this.lat0), this.cos_p12 = Math.cos(this.lat0)
            }, c.forward = function(a){
                var b, c, m, n, o, p, q, r, s, t, u, v, w, x, y, z, A, B, C, D, E, F, G, H = a.x, I = a.y,
                    J = Math.sin(a.y), K = Math.cos(a.y), L = d(H - this.long0);
                return this.sphere? Math.abs(this.sin_p12 - 1) <= f? (a.x = this.x0 + this.a * (e - I) * Math.sin(L), a.y = this.y0 - this.a * (e - I) * Math.cos(L), a) : Math.abs(this.sin_p12 + 1) <= f? (a.x = this.x0 + this.a * (e + I) * Math.sin(L), a.y = this.y0 + this.a * (e + I) * Math.cos(L), a) : (B = this.sin_p12 * J + this.cos_p12 * K * Math.cos(L), z = Math.acos(B), A = z / Math.sin(z), a.x = this.x0 + this.a * A * K * Math.sin(L), a.y = this.y0 + this.a * A * (this.cos_p12 * J - this.sin_p12 * K * Math.cos(L)), a) : (b = h(this.es), c = i(this.es), m = j(this.es), n = k(this.es), Math.abs(this.sin_p12 - 1) <= f? (o = this.a * g(b, c, m, n, e), p = this.a * g(b, c, m, n, I), a.x = this.x0 + (o - p) * Math.sin(L), a.y = this.y0 - (o - p) * Math.cos(L), a) : Math.abs(this.sin_p12 + 1) <= f? (o = this.a * g(b, c, m, n, e), p = this.a * g(b, c, m, n, I), a.x = this.x0 + (o + p) * Math.sin(L), a.y = this.y0 + (o + p) * Math.cos(L), a) : (q = J / K, r = l(this.a, this.e, this.sin_p12), s = l(this.a, this.e, J), t = Math.atan((1 - this.es) * q + this.es * r * this.sin_p12 / (s * K)), u = Math.atan2(Math.sin(L), this.cos_p12 * Math.tan(t) - this.sin_p12 * Math.cos(L)), C = 0 === u? Math.asin(this.cos_p12 * Math.sin(t) - this.sin_p12 * Math.cos(t)) : Math.abs(Math.abs(u) - Math.PI) <= f? -Math.asin(this.cos_p12 * Math.sin(t) - this.sin_p12 * Math.cos(t)) : Math.asin(Math.sin(L) * Math.cos(t) / Math.sin(u)), v = this.e * this.sin_p12 / Math.sqrt(1 - this.es), w = this.e * this.cos_p12 * Math.cos(u) / Math.sqrt(1 - this.es), x = v * w, y = w * w, D = C * C, E = D * C, F = E * C, G = F * C, z = r * C * (1 - D * y * (1 - y) / 6 + E / 8 * x * (1 - 2 * y) + F / 120 * (y * (4 - 7 * y) - 3 * v * v * (1 - 7 * y)) - G / 48 * x), a.x = this.x0 + z * Math.sin(u), a.y = this.y0 + z * Math.cos(u), a))
            }, c.inverse = function(a){
                a.x -= this.x0, a.y -= this.y0;
                var b, c, o, p, q, r, s, t, u, v, w, x, y, z, A, B, C, D, E, F, G, H, I;
                if(this.sphere)
                {
                    if(b = Math.sqrt(a.x * a.x + a.y * a.y), b > 2 * e * this.a) return;
                    return c = b / this.a, o = Math.sin(c), p = Math.cos(c), q = this.long0, Math.abs(b) <= f? r = this.lat0 : (r = m(p * this.sin_p12 + a.y * o * this.cos_p12 / b), s = Math.abs(this.lat0) - e, q = d(Math.abs(s) <= f? this.lat0 >= 0? this.long0 + Math.atan2(a.x, -a.y) : this.long0 - Math.atan2(-a.x, a.y) : this.long0 + Math.atan2(a.x * o, b * this.cos_p12 * p - a.y * this.sin_p12 * o))), a.x = q, a.y = r, a
                }
                return t = h(this.es), u = i(this.es), v = j(this.es), w = k(this.es), Math.abs(this.sin_p12 - 1) <= f? (x = this.a * g(t, u, v, w, e), b = Math.sqrt(a.x * a.x + a.y * a.y), y = x - b, r = n(y / this.a, t, u, v, w), q = d(this.long0 + Math.atan2(a.x, -1 * a.y)), a.x = q, a.y = r, a) : Math.abs(this.sin_p12 + 1) <= f? (x = this.a * g(t, u, v, w, e), b = Math.sqrt(a.x * a.x + a.y * a.y), y = b - x, r = n(y / this.a, t, u, v, w), q = d(this.long0 + Math.atan2(a.x, a.y)), a.x = q, a.y = r, a) : (b = Math.sqrt(a.x * a.x + a.y * a.y), B = Math.atan2(a.x, a.y), z = l(this.a, this.e, this.sin_p12), C = Math.cos(B), D = this.e * this.cos_p12 * C, E = -D * D / (1 - this.es), F = 3 * this.es * (1 - E) * this.sin_p12 * this.cos_p12 * C / (1 - this.es), G = b / z, H = G - E * (1 + E) * Math.pow(G, 3) / 6 - F * (1 + 3 * E) * Math.pow(G, 4) / 24, I = 1 - E * H * H / 2 - G * H * H * H / 6, A = Math.asin(this.sin_p12 * Math.cos(H) + this.cos_p12 * Math.sin(H) * C), q = d(this.long0 + Math.asin(Math.sin(B) * Math.sin(H) / Math.cos(A))), r = Math.atan((1 - this.es * I * this.sin_p12 / Math.sin(A)) * Math.tan(A) / (1 - this.es)), a.x = q, a.y = r, a)
            }, c.names = ["Azimuthal_Equidistant", "aeqd"]
        }, {
            "../common/adjust_lon": 5,
            "../common/asinz"     : 6,
            "../common/e0fn"      : 7,
            "../common/e1fn"      : 8,
            "../common/e2fn"      : 9,
            "../common/e3fn"      : 10,
            "../common/gN"        : 11,
            "../common/imlfn"     : 12,
            "../common/mlfn"      : 14
        }],
        41                     : [function(a, b, c){
            var d = a("../common/mlfn"), e = a("../common/e0fn"), f = a("../common/e1fn"), g = a("../common/e2fn"),
                h = a("../common/e3fn"), i = a("../common/gN"), j = a("../common/adjust_lon"),
                k = a("../common/adjust_lat"), l = a("../common/imlfn"), m = Math.PI / 2, n = 1e-10;
            c.init = function(){
                this.sphere || (this.e0 = e(this.es), this.e1 = f(this.es), this.e2 = g(this.es), this.e3 = h(this.es), this.ml0 = this.a * d(this.e0, this.e1, this.e2, this.e3, this.lat0))
            }, c.forward = function(a){
                var b, c, e = a.x, f = a.y;
                if(e = j(e - this.long0), this.sphere) b = this.a * Math.asin(Math.cos(f) * Math.sin(e)), c = this.a * (Math.atan2(Math.tan(f), Math.cos(e)) - this.lat0);
                else
                {
                    var g = Math.sin(f), h = Math.cos(f), k = i(this.a, this.e, g), l = Math.tan(f) * Math.tan(f),
                        m = e * Math.cos(f), n = m * m, o = this.es * h * h / (1 - this.es),
                        p = this.a * d(this.e0, this.e1, this.e2, this.e3, f);
                    b = k * m * (1 - n * l * (1 / 6 - (8 - l + 8 * o) * n / 120)), c = p - this.ml0 + k * g / h * n * (.5 + (5 - l + 6 * o) * n / 24)
                }
                return a.x = b + this.x0, a.y = c + this.y0, a
            }, c.inverse = function(a){
                a.x -= this.x0, a.y -= this.y0;
                var b, c, d = a.x / this.a, e = a.y / this.a;
                if(this.sphere)
                {
                    var f = e + this.lat0;
                    b = Math.asin(Math.sin(f) * Math.cos(d)), c = Math.atan2(Math.tan(d), Math.cos(f))
                }
                else
                {
                    var g = this.ml0 / this.a + e, h = l(g, this.e0, this.e1, this.e2, this.e3);
                    if(Math.abs(Math.abs(h) - m) <= n) return a.x = this.long0, a.y = m, 0 > e && (a.y *= -1), a;
                    var o = i(this.a, this.e, Math.sin(h)), p = o * o * o / this.a / this.a * (1 - this.es),
                        q = Math.pow(Math.tan(h), 2), r = d * this.a / o, s = r * r;
                    b = h - o * Math.tan(h) / p * r * r * (.5 - (1 + 3 * q) * r * r / 24), c = r * (1 - s * (q / 3 + (1 + 3 * q) * q * s / 15)) / Math.cos(h)
                }
                return a.x = j(c + this.long0), a.y = k(b), a
            }, c.names = ["Cassini", "Cassini_Soldner", "cass"]
        }, {
            "../common/adjust_lat": 4,
            "../common/adjust_lon": 5,
            "../common/e0fn"      : 7,
            "../common/e1fn"      : 8,
            "../common/e2fn"      : 9,
            "../common/e3fn"      : 10,
            "../common/gN"        : 11,
            "../common/imlfn"     : 12,
            "../common/mlfn"      : 14
        }],
        42                     : [function(a, b, c){
            var d = a("../common/adjust_lon"), e = a("../common/qsfnz"), f = a("../common/msfnz"),
                g = a("../common/iqsfnz");
            c.init = function(){
                this.sphere || (this.k0 = f(this.e, Math.sin(this.lat_ts), Math.cos(this.lat_ts)))
            }, c.forward = function(a){
                var b, c, f = a.x, g = a.y, h = d(f - this.long0);
                if(this.sphere) b = this.x0 + this.a * h * Math.cos(this.lat_ts), c = this.y0 + this.a * Math.sin(g) / Math.cos(this.lat_ts);
                else
                {
                    var i = e(this.e, Math.sin(g));
                    b = this.x0 + this.a * this.k0 * h, c = this.y0 + this.a * i * .5 / this.k0
                }
                return a.x = b, a.y = c, a
            }, c.inverse = function(a){
                a.x -= this.x0, a.y -= this.y0;
                var b, c;
                return this.sphere? (b = d(this.long0 + a.x / this.a / Math.cos(this.lat_ts)), c = Math.asin(a.y / this.a * Math.cos(this.lat_ts))) : (c = g(this.e, 2 * a.y * this.k0 / this.a), b = d(this.long0 + a.x / (this.a * this.k0))), a.x = b, a.y = c, a
            }, c.names = ["cea"]
        }, {"../common/adjust_lon": 5, "../common/iqsfnz": 13, "../common/msfnz": 15, "../common/qsfnz": 20}],
        43                     : [function(a, b, c){
            var d = a("../common/adjust_lon"), e = a("../common/adjust_lat");
            c.init = function(){
                this.x0 = this.x0 || 0, this.y0 = this.y0 || 0, this.lat0 = this.lat0 || 0, this.long0 = this.long0 || 0, this.lat_ts = this.lat_ts || 0, this.title = this.title || "Equidistant Cylindrical (Plate Carre)", this.rc = Math.cos(this.lat_ts)
            }, c.forward = function(a){
                var b = a.x, c = a.y, f = d(b - this.long0), g = e(c - this.lat0);
                return a.x = this.x0 + this.a * f * this.rc, a.y = this.y0 + this.a * g, a
            }, c.inverse = function(a){
                var b = a.x, c = a.y;
                return a.x = d(this.long0 + (b - this.x0) / (this.a * this.rc)), a.y = e(this.lat0 + (c - this.y0) / this.a), a
            }, c.names = ["Equirectangular", "Equidistant_Cylindrical", "eqc"]
        }, {"../common/adjust_lat": 4, "../common/adjust_lon": 5}],
        44                     : [function(a, b, c){
            var d = a("../common/e0fn"), e = a("../common/e1fn"), f = a("../common/e2fn"), g = a("../common/e3fn"),
                h = a("../common/msfnz"), i = a("../common/mlfn"), j = a("../common/adjust_lon"),
                k = a("../common/adjust_lat"), l = a("../common/imlfn"), m = 1e-10;
            c.init = function(){
                Math.abs(this.lat1 + this.lat2) < m || (this.lat2 = this.lat2 || this.lat1, this.temp = this.b / this.a, this.es = 1 - Math.pow(this.temp, 2), this.e = Math.sqrt(this.es), this.e0 = d(this.es), this.e1 = e(this.es), this.e2 = f(this.es), this.e3 = g(this.es), this.sinphi = Math.sin(this.lat1), this.cosphi = Math.cos(this.lat1), this.ms1 = h(this.e, this.sinphi, this.cosphi), this.ml1 = i(this.e0, this.e1, this.e2, this.e3, this.lat1), Math.abs(this.lat1 - this.lat2) < m? this.ns = this.sinphi : (this.sinphi = Math.sin(this.lat2), this.cosphi = Math.cos(this.lat2), this.ms2 = h(this.e, this.sinphi, this.cosphi), this.ml2 = i(this.e0, this.e1, this.e2, this.e3, this.lat2), this.ns = (this.ms1 - this.ms2) / (this.ml2 - this.ml1)), this.g = this.ml1 + this.ms1 / this.ns, this.ml0 = i(this.e0, this.e1, this.e2, this.e3, this.lat0), this.rh = this.a * (this.g - this.ml0))
            }, c.forward = function(a){
                var b, c = a.x, d = a.y;
                if(this.sphere) b = this.a * (this.g - d);
                else
                {
                    var e = i(this.e0, this.e1, this.e2, this.e3, d);
                    b = this.a * (this.g - e)
                }
                var f = this.ns * j(c - this.long0), g = this.x0 + b * Math.sin(f),
                    h = this.y0 + this.rh - b * Math.cos(f);
                return a.x = g, a.y = h, a
            }, c.inverse = function(a){
                a.x -= this.x0, a.y = this.rh - a.y + this.y0;
                var b, c, d, e;
                this.ns >= 0? (c = Math.sqrt(a.x * a.x + a.y * a.y), b = 1) : (c = -Math.sqrt(a.x * a.x + a.y * a.y), b = -1);
                var f = 0;
                if(0 !== c && (f = Math.atan2(b * a.x, b * a.y)), this.sphere) return e = j(this.long0 + f / this.ns), d = k(this.g - c / this.a), a.x = e, a.y = d, a;
                var g = this.g - c / this.a;
                return d = l(g, this.e0, this.e1, this.e2, this.e3), e = j(this.long0 + f / this.ns), a.x = e, a.y = d, a
            }, c.names = ["Equidistant_Conic", "eqdc"]
        }, {
            "../common/adjust_lat": 4,
            "../common/adjust_lon": 5,
            "../common/e0fn"      : 7,
            "../common/e1fn"      : 8,
            "../common/e2fn"      : 9,
            "../common/e3fn"      : 10,
            "../common/imlfn"     : 12,
            "../common/mlfn"      : 14,
            "../common/msfnz"     : 15
        }],
        45                     : [function(a, b, c){
            var d = Math.PI / 4, e = a("../common/srat"), f = Math.PI / 2, g = 20;
            c.init = function(){
                var a = Math.sin(this.lat0), b = Math.cos(this.lat0);
                b *= b, this.rc = Math.sqrt(1 - this.es) / (1 - this.es * a * a), this.C = Math.sqrt(1 + this.es * b * b / (1 - this.es)), this.phic0 = Math.asin(a / this.C), this.ratexp = .5 * this.C * this.e, this.K = Math.tan(.5 * this.phic0 + d) / (Math.pow(Math.tan(.5 * this.lat0 + d), this.C) * e(this.e * a, this.ratexp))
            }, c.forward = function(a){
                var b = a.x, c = a.y;
                return a.y = 2 * Math.atan(this.K * Math.pow(Math.tan(.5 * c + d), this.C) * e(this.e * Math.sin(c), this.ratexp)) - f, a.x = this.C * b, a
            }, c.inverse = function(a){
                for(var b = 1e-14, c = a.x / this.C, h = a.y, i = Math.pow(Math.tan(.5 * h + d) / this.K, 1 / this.C), j = g ; j > 0 && (h = 2 * Math.atan(i * e(this.e * Math.sin(a.y), -.5 * this.e)) - f, !(Math.abs(h - a.y) < b)) ; --j) a.y = h;
                return j? (a.x = c, a.y = h, a) : null
            }, c.names = ["gauss"]
        }, {"../common/srat": 22}],
        46                     : [function(a, b, c){
            var d = a("../common/adjust_lon"), e = 1e-10, f = a("../common/asinz");
            c.init = function(){
                this.sin_p14 = Math.sin(this.lat0), this.cos_p14 = Math.cos(this.lat0), this.infinity_dist = 1e3 * this.a, this.rc = 1
            }, c.forward = function(a){
                var b, c, f, g, h, i, j, k, l = a.x, m = a.y;
                return f = d(l - this.long0), b = Math.sin(m), c = Math.cos(m), g = Math.cos(f), i = this.sin_p14 * b + this.cos_p14 * c * g, h = 1, i > 0 || Math.abs(i) <= e? (j = this.x0 + this.a * h * c * Math.sin(f) / i, k = this.y0 + this.a * h * (this.cos_p14 * b - this.sin_p14 * c * g) / i) : (j = this.x0 + this.infinity_dist * c * Math.sin(f), k = this.y0 + this.infinity_dist * (this.cos_p14 * b - this.sin_p14 * c * g)), a.x = j, a.y = k, a
            }, c.inverse = function(a){
                var b, c, e, g, h, i;
                return a.x = (a.x - this.x0) / this.a, a.y = (a.y - this.y0) / this.a, a.x /= this.k0, a.y /= this.k0, (b = Math.sqrt(a.x * a.x + a.y * a.y))? (g = Math.atan2(b, this.rc), c = Math.sin(g), e = Math.cos(g), i = f(e * this.sin_p14 + a.y * c * this.cos_p14 / b), h = Math.atan2(a.x * c, b * this.cos_p14 * e - a.y * this.sin_p14 * c), h = d(this.long0 + h)) : (i = this.phic0, h = 0), a.x = h, a.y = i, a
            }, c.names = ["gnom"]
        }, {"../common/adjust_lon": 5, "../common/asinz": 6}],
        47                     : [function(a, b, c){
            var d = a("../common/adjust_lon");
            c.init = function(){
                this.a = 6377397.155, this.es = .006674372230614, this.e = Math.sqrt(this.es), this.lat0 || (this.lat0 = .863937979737193), this.long0 || (this.long0 = .4334234309119251), this.k0 || (this.k0 = .9999), this.s45 = .785398163397448, this.s90 = 2 * this.s45, this.fi0 = this.lat0, this.e2 = this.es, this.e = Math.sqrt(this.e2), this.alfa = Math.sqrt(1 + this.e2 * Math.pow(Math.cos(this.fi0), 4) / (1 - this.e2)), this.uq = 1.04216856380474, this.u0 = Math.asin(Math.sin(this.fi0) / this.alfa), this.g = Math.pow((1 + this.e * Math.sin(this.fi0)) / (1 - this.e * Math.sin(this.fi0)), this.alfa * this.e / 2), this.k = Math.tan(this.u0 / 2 + this.s45) / Math.pow(Math.tan(this.fi0 / 2 + this.s45), this.alfa) * this.g, this.k1 = this.k0, this.n0 = this.a * Math.sqrt(1 - this.e2) / (1 - this.e2 * Math.pow(Math.sin(this.fi0), 2)), this.s0 = 1.37008346281555, this.n = Math.sin(this.s0), this.ro0 = this.k1 * this.n0 / Math.tan(this.s0), this.ad = this.s90 - this.uq
            }, c.forward = function(a){
                var b, c, e, f, g, h, i, j = a.x, k = a.y, l = d(j - this.long0);
                return b = Math.pow((1 + this.e * Math.sin(k)) / (1 - this.e * Math.sin(k)), this.alfa * this.e / 2), c = 2 * (Math.atan(this.k * Math.pow(Math.tan(k / 2 + this.s45), this.alfa) / b) - this.s45), e = -l * this.alfa, f = Math.asin(Math.cos(this.ad) * Math.sin(c) + Math.sin(this.ad) * Math.cos(c) * Math.cos(e)), g = Math.asin(Math.cos(c) * Math.sin(e) / Math.cos(f)), h = this.n * g, i = this.ro0 * Math.pow(Math.tan(this.s0 / 2 + this.s45), this.n) / Math.pow(Math.tan(f / 2 + this.s45), this.n), a.y = i * Math.cos(h) / 1, a.x = i * Math.sin(h) / 1, this.czech || (a.y *= -1, a.x *= -1), a
            }, c.inverse = function(a){
                var b, c, d, e, f, g, h, i, j = a.x;
                a.x = a.y, a.y = j, this.czech || (a.y *= -1, a.x *= -1), g = Math.sqrt(a.x * a.x + a.y * a.y), f = Math.atan2(a.y, a.x), e = f / Math.sin(this.s0), d = 2 * (Math.atan(Math.pow(this.ro0 / g, 1 / this.n) * Math.tan(this.s0 / 2 + this.s45)) - this.s45), b = Math.asin(Math.cos(this.ad) * Math.sin(d) - Math.sin(this.ad) * Math.cos(d) * Math.cos(e)), c = Math.asin(Math.cos(d) * Math.sin(e) / Math.cos(b)), a.x = this.long0 - c / this.alfa, h = b, i = 0;
                var k = 0;
                do a.y = 2 * (Math.atan(Math.pow(this.k, -1 / this.alfa) * Math.pow(Math.tan(b / 2 + this.s45), 1 / this.alfa) * Math.pow((1 + this.e * Math.sin(h)) / (1 - this.e * Math.sin(h)), this.e / 2)) - this.s45), Math.abs(h - a.y) < 1e-10 && (i = 1), h = a.y, k += 1;while(0 === i && 15 > k);
                return k >= 15? null : a
            }, c.names = ["Krovak", "krovak"]
        }, {"../common/adjust_lon": 5}],
        48                     : [function(a, b, c){
            var d = Math.PI / 2, e = Math.PI / 4, f = 1e-10, g = a("../common/qsfnz"), h = a("../common/adjust_lon");
            c.S_POLE = 1, c.N_POLE = 2, c.EQUIT = 3, c.OBLIQ = 4, c.init = function(){
                var a = Math.abs(this.lat0);
                if(this.mode = Math.abs(a - d) < f? this.lat0 < 0? this.S_POLE : this.N_POLE : Math.abs(a) < f? this.EQUIT : this.OBLIQ, this.es > 0)
                {
                    var b;
                    switch(this.qp = g(this.e, 1), this.mmf = .5 / (1 - this.es), this.apa = this.authset(this.es), this.mode)
                    {
                        case this.N_POLE:
                            this.dd = 1;
                            break;
                        case this.S_POLE:
                            this.dd = 1;
                            break;
                        case this.EQUIT:
                            this.rq = Math.sqrt(.5 * this.qp), this.dd = 1 / this.rq, this.xmf = 1, this.ymf = .5 * this.qp;
                            break;
                        case this.OBLIQ:
                            this.rq = Math.sqrt(.5 * this.qp), b = Math.sin(this.lat0), this.sinb1 = g(this.e, b) / this.qp, this.cosb1 = Math.sqrt(1 - this.sinb1 * this.sinb1), this.dd = Math.cos(this.lat0) / (Math.sqrt(1 - this.es * b * b) * this.rq * this.cosb1), this.ymf = (this.xmf = this.rq) / this.dd, this.xmf *= this.dd
                    }
                }
                else this.mode === this.OBLIQ && (this.sinph0 = Math.sin(this.lat0), this.cosph0 = Math.cos(this.lat0))
            }, c.forward = function(a){
                var b, c, i, j, k, l, m, n, o, p, q = a.x, r = a.y;
                if(q = h(q - this.long0), this.sphere)
                {
                    if(k = Math.sin(r), p = Math.cos(r), i = Math.cos(q), this.mode === this.OBLIQ || this.mode === this.EQUIT)
                    {
                        if(c = this.mode === this.EQUIT? 1 + p * i : 1 + this.sinph0 * k + this.cosph0 * p * i, f >= c) return null;
                        c = Math.sqrt(2 / c), b = c * p * Math.sin(q), c *= this.mode === this.EQUIT? k : this.cosph0 * k - this.sinph0 * p * i
                    }
                    else if(this.mode === this.N_POLE || this.mode === this.S_POLE)
                    {
                        if(this.mode === this.N_POLE && (i = -i), Math.abs(r + this.phi0) < f) return null;
                        c = e - .5 * r, c = 2 * (this.mode === this.S_POLE? Math.cos(c) : Math.sin(c)), b = c * Math.sin(q), c *= i
                    }
                }
                else
                {
                    switch(m = 0, n = 0, o = 0, i = Math.cos(q), j = Math.sin(q), k = Math.sin(r), l = g(this.e, k), (this.mode === this.OBLIQ || this.mode === this.EQUIT) && (m = l / this.qp, n = Math.sqrt(1 - m * m)), this.mode)
                    {
                        case this.OBLIQ:
                            o = 1 + this.sinb1 * m + this.cosb1 * n * i;
                            break;
                        case this.EQUIT:
                            o = 1 + n * i;
                            break;
                        case this.N_POLE:
                            o = d + r, l = this.qp - l;
                            break;
                        case this.S_POLE:
                            o = r - d, l = this.qp + l
                    }
                    if(Math.abs(o) < f) return null;
                    switch(this.mode)
                    {
                        case this.OBLIQ:
                        case this.EQUIT:
                            o = Math.sqrt(2 / o), c = this.mode === this.OBLIQ? this.ymf * o * (this.cosb1 * m - this.sinb1 * n * i) : (o = Math.sqrt(2 / (1 + n * i))) * m * this.ymf, b = this.xmf * o * n * j;
                            break;
                        case this.N_POLE:
                        case this.S_POLE:
                            l >= 0? (b = (o = Math.sqrt(l)) * j, c = i * (this.mode === this.S_POLE? o : -o)) : b = c = 0
                    }
                }
                return a.x = this.a * b + this.x0, a.y = this.a * c + this.y0, a
            }, c.inverse = function(a){
                a.x -= this.x0, a.y -= this.y0;
                var b, c, e, g, i, j, k, l = a.x / this.a, m = a.y / this.a;
                if(this.sphere)
                {
                    var n, o = 0, p = 0;
                    if(n = Math.sqrt(l * l + m * m), c = .5 * n, c > 1) return null;
                    switch(c = 2 * Math.asin(c), (this.mode === this.OBLIQ || this.mode === this.EQUIT) && (p = Math.sin(c), o = Math.cos(c)), this.mode)
                    {
                        case this.EQUIT:
                            c = Math.abs(n) <= f? 0 : Math.asin(m * p / n), l *= p, m = o * n;
                            break;
                        case this.OBLIQ:
                            c = Math.abs(n) <= f? this.phi0 : Math.asin(o * this.sinph0 + m * p * this.cosph0 / n), l *= p * this.cosph0, m = (o - Math.sin(c) * this.sinph0) * n;
                            break;
                        case this.N_POLE:
                            m = -m, c = d - c;
                            break;
                        case this.S_POLE:
                            c -= d
                    }
                    b = 0 !== m || this.mode !== this.EQUIT && this.mode !== this.OBLIQ? Math.atan2(l, m) : 0
                }
                else
                {
                    if(k = 0, this.mode === this.OBLIQ || this.mode === this.EQUIT)
                    {
                        if(l /= this.dd, m *= this.dd, j = Math.sqrt(l * l + m * m), f > j) return a.x = 0, a.y = this.phi0, a;
                        g = 2 * Math.asin(.5 * j / this.rq), e = Math.cos(g), l *= g = Math.sin(g), this.mode === this.OBLIQ? (k = e * this.sinb1 + m * g * this.cosb1 / j, i = this.qp * k, m = j * this.cosb1 * e - m * this.sinb1 * g) : (k = m * g / j, i = this.qp * k, m = j * e)
                    }
                    else if(this.mode === this.N_POLE || this.mode === this.S_POLE)
                    {
                        if(this.mode === this.N_POLE && (m = -m), i = l * l + m * m, !i) return a.x = 0, a.y = this.phi0, a;
                        k = 1 - i / this.qp, this.mode === this.S_POLE && (k = -k)
                    }
                    b = Math.atan2(l, m), c = this.authlat(Math.asin(k), this.apa)
                }
                return a.x = h(this.long0 + b), a.y = c, a
            }, c.P00 = .3333333333333333, c.P01 = .17222222222222222, c.P02 = .10257936507936508, c.P10 = .06388888888888888, c.P11 = .0664021164021164, c.P20 = .016415012942191543, c.authset = function(a){
                var b, c = [];
                return c[0] = a * this.P00, b = a * a, c[0] += b * this.P01, c[1] = b * this.P10, b *= a, c[0] += b * this.P02, c[1] += b * this.P11, c[2] = b * this.P20, c
            }, c.authlat = function(a, b){
                var c = a + a;
                return a + b[0] * Math.sin(c) + b[1] * Math.sin(c + c) + b[2] * Math.sin(c + c + c)
            }, c.names = ["Lambert Azimuthal Equal Area", "Lambert_Azimuthal_Equal_Area", "laea"]
        }, {"../common/adjust_lon": 5, "../common/qsfnz": 20}],
        49                     : [function(a, b, c){
            var d = 1e-10, e = a("../common/msfnz"), f = a("../common/tsfnz"), g = Math.PI / 2, h = a("../common/sign"),
                i = a("../common/adjust_lon"), j = a("../common/phi2z");
            c.init = function(){
                if(this.lat2 || (this.lat2 = this.lat1), this.k0 || (this.k0 = 1), this.x0 = this.x0 || 0, this.y0 = this.y0 || 0, !(Math.abs(this.lat1 + this.lat2) < d))
                {
                    var a = this.b / this.a;
                    this.e = Math.sqrt(1 - a * a);
                    var b = Math.sin(this.lat1), c = Math.cos(this.lat1), g = e(this.e, b, c),
                        h = f(this.e, this.lat1, b), i = Math.sin(this.lat2), j = Math.cos(this.lat2),
                        k = e(this.e, i, j), l = f(this.e, this.lat2, i), m = f(this.e, this.lat0, Math.sin(this.lat0));
                    this.ns = Math.abs(this.lat1 - this.lat2) > d? Math.log(g / k) / Math.log(h / l) : b, isNaN(this.ns) && (this.ns = b), this.f0 = g / (this.ns * Math.pow(h, this.ns)), this.rh = this.a * this.f0 * Math.pow(m, this.ns), this.title || (this.title = "Lambert Conformal Conic")
                }
            }, c.forward = function(a){
                var b = a.x, c = a.y;
                Math.abs(2 * Math.abs(c) - Math.PI) <= d && (c = h(c) * (g - 2 * d));
                var e, j, k = Math.abs(Math.abs(c) - g);
                if(k > d) e = f(this.e, c, Math.sin(c)), j = this.a * this.f0 * Math.pow(e, this.ns);
                else
                {
                    if(k = c * this.ns, 0 >= k) return null;
                    j = 0
                }
                var l = this.ns * i(b - this.long0);
                return a.x = this.k0 * j * Math.sin(l) + this.x0, a.y = this.k0 * (this.rh - j * Math.cos(l)) + this.y0, a
            }, c.inverse = function(a){
                var b, c, d, e, f, h = (a.x - this.x0) / this.k0, k = this.rh - (a.y - this.y0) / this.k0;
                this.ns > 0? (b = Math.sqrt(h * h + k * k), c = 1) : (b = -Math.sqrt(h * h + k * k), c = -1);
                var l = 0;
                if(0 !== b && (l = Math.atan2(c * h, c * k)), 0 !== b || this.ns > 0)
                {
                    if(c = 1 / this.ns, d = Math.pow(b / (this.a * this.f0), c), e = j(this.e, d), -9999 === e) return null
                }
                else e = -g;
                return f = i(l / this.ns + this.long0), a.x = f, a.y = e, a
            }, c.names = ["Lambert Tangential Conformal Conic Projection", "Lambert_Conformal_Conic", "Lambert_Conformal_Conic_2SP", "lcc"]
        }, {
            "../common/adjust_lon": 5,
            "../common/msfnz"     : 15,
            "../common/phi2z"     : 16,
            "../common/sign"      : 21,
            "../common/tsfnz"     : 24
        }],
        50                     : [function(a, b, c){
            function d(a)
            {
                return a
            }

            c.init = function(){
            }, c.forward = d, c.inverse = d, c.names = ["longlat", "identity"]
        }, {}],
        51                     : [function(a, b, c){
            var d = a("../common/msfnz"), e = Math.PI / 2, f = 1e-10, g = 57.29577951308232,
                h = a("../common/adjust_lon"), i = Math.PI / 4, j = a("../common/tsfnz"), k = a("../common/phi2z");
            c.init = function(){
                var a = this.b / this.a;
                this.es = 1 - a * a, "x0" in this || (this.x0 = 0), "y0" in this || (this.y0 = 0), this.e = Math.sqrt(this.es), this.lat_ts? this.k0 = this.sphere? Math.cos(this.lat_ts) : d(this.e, Math.sin(this.lat_ts), Math.cos(this.lat_ts)) : this.k0 || (this.k0 = this.k? this.k : 1)
            }, c.forward = function(a){
                var b = a.x, c = a.y;
                if(c * g > 90 && -90 > c * g && b * g > 180 && -180 > b * g) return null;
                var d, k;
                if(Math.abs(Math.abs(c) - e) <= f) return null;
                if(this.sphere) d = this.x0 + this.a * this.k0 * h(b - this.long0), k = this.y0 + this.a * this.k0 * Math.log(Math.tan(i + .5 * c));
                else
                {
                    var l = Math.sin(c), m = j(this.e, c, l);
                    d = this.x0 + this.a * this.k0 * h(b - this.long0), k = this.y0 - this.a * this.k0 * Math.log(m)
                }
                return a.x = d, a.y = k, a
            }, c.inverse = function(a){
                var b, c, d = a.x - this.x0, f = a.y - this.y0;
                if(this.sphere) c = e - 2 * Math.atan(Math.exp(-f / (this.a * this.k0)));
                else
                {
                    var g = Math.exp(-f / (this.a * this.k0));
                    if(c = k(this.e, g), -9999 === c) return null
                }
                return b = h(this.long0 + d / (this.a * this.k0)), a.x = b, a.y = c, a
            }, c.names = ["Mercator", "Popular Visualisation Pseudo Mercator", "Mercator_1SP", "Mercator_Auxiliary_Sphere", "merc"]
        }, {"../common/adjust_lon": 5, "../common/msfnz": 15, "../common/phi2z": 16, "../common/tsfnz": 24}],
        52                     : [function(a, b, c){
            var d = a("../common/adjust_lon");
            c.init = function(){
            }, c.forward = function(a){
                var b = a.x, c = a.y, e = d(b - this.long0), f = this.x0 + this.a * e,
                    g = this.y0 + this.a * Math.log(Math.tan(Math.PI / 4 + c / 2.5)) * 1.25;
                return a.x = f, a.y = g, a
            }, c.inverse = function(a){
                a.x -= this.x0, a.y -= this.y0;
                var b = d(this.long0 + a.x / this.a), c = 2.5 * (Math.atan(Math.exp(.8 * a.y / this.a)) - Math.PI / 4);
                return a.x = b, a.y = c, a
            }, c.names = ["Miller_Cylindrical", "mill"]
        }, {"../common/adjust_lon": 5}],
        53                     : [function(a, b, c){
            var d = a("../common/adjust_lon"), e = 1e-10;
            c.init = function(){
            }, c.forward = function(a){
                for(var b = a.x, c = a.y, f = d(b - this.long0), g = c, h = Math.PI * Math.sin(c), i = 0 ; !0 ; i++)
                {
                    var j = -(g + Math.sin(g) - h) / (1 + Math.cos(g));
                    if(g += j, Math.abs(j) < e) break
                }
                g /= 2, Math.PI / 2 - Math.abs(c) < e && (f = 0);
                var k = .900316316158 * this.a * f * Math.cos(g) + this.x0,
                    l = 1.4142135623731 * this.a * Math.sin(g) + this.y0;
                return a.x = k, a.y = l, a
            }, c.inverse = function(a){
                var b, c;
                a.x -= this.x0, a.y -= this.y0, c = a.y / (1.4142135623731 * this.a), Math.abs(c) > .999999999999 && (c = .999999999999), b = Math.asin(c);
                var e = d(this.long0 + a.x / (.900316316158 * this.a * Math.cos(b)));
                e < -Math.PI && (e = -Math.PI), e > Math.PI && (e = Math.PI), c = (2 * b + Math.sin(2 * b)) / Math.PI, Math.abs(c) > 1 && (c = 1);
                var f = Math.asin(c);
                return a.x = e, a.y = f, a
            }, c.names = ["Mollweide", "moll"]
        }, {"../common/adjust_lon": 5}],
        54                     : [function(a, b, c){
            var d = 484813681109536e-20;
            c.iterations = 1, c.init = function(){
                this.A = [], this.A[1] = .6399175073, this.A[2] = -.1358797613, this.A[3] = .063294409, this.A[4] = -.02526853, this.A[5] = .0117879, this.A[6] = -.0055161, this.A[7] = .0026906, this.A[8] = -.001333, this.A[9] = 67e-5, this.A[10] = -34e-5, this.B_re = [], this.B_im = [], this.B_re[1] = .7557853228, this.B_im[1] = 0, this.B_re[2] = .249204646, this.B_im[2] = .003371507, this.B_re[3] = -.001541739, this.B_im[3] = .04105856, this.B_re[4] = -.10162907, this.B_im[4] = .01727609, this.B_re[5] = -.26623489, this.B_im[5] = -.36249218, this.B_re[6] = -.6870983, this.B_im[6] = -1.1651967, this.C_re = [], this.C_im = [], this.C_re[1] = 1.3231270439, this.C_im[1] = 0, this.C_re[2] = -.577245789, this.C_im[2] = -.007809598, this.C_re[3] = .508307513, this.C_im[3] = -.112208952, this.C_re[4] = -.15094762, this.C_im[4] = .18200602, this.C_re[5] = 1.01418179, this.C_im[5] = 1.64497696, this.C_re[6] = 1.9660549, this.C_im[6] = 2.5127645, this.D = [], this.D[1] = 1.5627014243, this.D[2] = .5185406398, this.D[3] = -.03333098, this.D[4] = -.1052906, this.D[5] = -.0368594, this.D[6] = .007317, this.D[7] = .0122, this.D[8] = .00394, this.D[9] = -.0013
            }, c.forward = function(a){
                var b, c = a.x, e = a.y, f = e - this.lat0, g = c - this.long0, h = f / d * 1e-5, i = g, j = 1, k = 0;
                for(b = 1 ; 10 >= b ; b++) j *= h, k += this.A[b] * j;
                var l, m, n = k, o = i, p = 1, q = 0, r = 0, s = 0;
                for(b = 1 ; 6 >= b ; b++) l = p * n - q * o, m = q * n + p * o, p = l, q = m, r = r + this.B_re[b] * p - this.B_im[b] * q, s = s + this.B_im[b] * p + this.B_re[b] * q;
                return a.x = s * this.a + this.x0, a.y = r * this.a + this.y0, a
            }, c.inverse = function(a){
                var b, c, e, f = a.x, g = a.y, h = f - this.x0, i = g - this.y0, j = i / this.a, k = h / this.a, l = 1,
                    m = 0, n = 0, o = 0;
                for(b = 1 ; 6 >= b ; b++) c = l * j - m * k, e = m * j + l * k, l = c, m = e, n = n + this.C_re[b] * l - this.C_im[b] * m, o = o + this.C_im[b] * l + this.C_re[b] * m;
                for(var p = 0 ; p < this.iterations ; p++)
                {
                    var q, r, s = n, t = o, u = j, v = k;
                    for(b = 2 ; 6 >= b ; b++) q = s * n - t * o, r = t * n + s * o, s = q, t = r, u += (b - 1) * (this.B_re[b] * s - this.B_im[b] * t), v += (b - 1) * (this.B_im[b] * s + this.B_re[b] * t);
                    s = 1, t = 0;
                    var w = this.B_re[1], x = this.B_im[1];
                    for(b = 2 ; 6 >= b ; b++) q = s * n - t * o, r = t * n + s * o, s = q, t = r, w += b * (this.B_re[b] * s - this.B_im[b] * t), x += b * (this.B_im[b] * s + this.B_re[b] * t);
                    var y = w * w + x * x;
                    n = (u * w + v * x) / y, o = (v * w - u * x) / y
                }
                var z = n, A = o, B = 1, C = 0;
                for(b = 1 ; 9 >= b ; b++) B *= z, C += this.D[b] * B;
                var D = this.lat0 + C * d * 1e5, E = this.long0 + A;
                return a.x = E, a.y = D, a
            }, c.names = ["New_Zealand_Map_Grid", "nzmg"]
        }, {}],
        55                     : [function(a, b, c){
            var d = a("../common/tsfnz"), e = a("../common/adjust_lon"), f = a("../common/phi2z"), g = Math.PI / 2,
                h = Math.PI / 4, i = 1e-10;
            c.init = function(){
                this.no_off = this.no_off || !1, this.no_rot = this.no_rot || !1, isNaN(this.k0) && (this.k0 = 1);
                var a = Math.sin(this.lat0), b = Math.cos(this.lat0), c = this.e * a;
                this.bl = Math.sqrt(1 + this.es / (1 - this.es) * Math.pow(b, 4)), this.al = this.a * this.bl * this.k0 * Math.sqrt(1 - this.es) / (1 - c * c);
                var f = d(this.e, this.lat0, a), g = this.bl / b * Math.sqrt((1 - this.es) / (1 - c * c));
                1 > g * g && (g = 1);
                var h, i;
                if(isNaN(this.longc))
                {
                    var j = d(this.e, this.lat1, Math.sin(this.lat1)), k = d(this.e, this.lat2, Math.sin(this.lat2));
                    this.el = this.lat0 >= 0? (g + Math.sqrt(g * g - 1)) * Math.pow(f, this.bl) : (g - Math.sqrt(g * g - 1)) * Math.pow(f, this.bl);
                    var l = Math.pow(j, this.bl), m = Math.pow(k, this.bl);
                    h = this.el / l, i = .5 * (h - 1 / h);
                    var n = (this.el * this.el - m * l) / (this.el * this.el + m * l), o = (m - l) / (m + l),
                        p = e(this.long1 - this.long2);
                    this.long0 = .5 * (this.long1 + this.long2) - Math.atan(n * Math.tan(.5 * this.bl * p) / o) / this.bl, this.long0 = e(this.long0);
                    var q = e(this.long1 - this.long0);
                    this.gamma0 = Math.atan(Math.sin(this.bl * q) / i), this.alpha = Math.asin(g * Math.sin(this.gamma0))
                }
                else h = this.lat0 >= 0? g + Math.sqrt(g * g - 1) : g - Math.sqrt(g * g - 1), this.el = h * Math.pow(f, this.bl), i = .5 * (h - 1 / h), this.gamma0 = Math.asin(Math.sin(this.alpha) / g), this.long0 = this.longc - Math.asin(i * Math.tan(this.gamma0)) / this.bl;
                this.uc = this.no_off? 0 : this.lat0 >= 0? this.al / this.bl * Math.atan2(Math.sqrt(g * g - 1), Math.cos(this.alpha)) : -1 * this.al / this.bl * Math.atan2(Math.sqrt(g * g - 1), Math.cos(this.alpha))
            }, c.forward = function(a){
                var b, c, f, j = a.x, k = a.y, l = e(j - this.long0);
                if(Math.abs(Math.abs(k) - g) <= i) f = k > 0? -1 : 1, c = this.al / this.bl * Math.log(Math.tan(h + f * this.gamma0 * .5)), b = -1 * f * g * this.al / this.bl;
                else
                {
                    var m = d(this.e, k, Math.sin(k)), n = this.el / Math.pow(m, this.bl), o = .5 * (n - 1 / n),
                        p = .5 * (n + 1 / n), q = Math.sin(this.bl * l),
                        r = (o * Math.sin(this.gamma0) - q * Math.cos(this.gamma0)) / p;
                    c = Math.abs(Math.abs(r) - 1) <= i? Number.POSITIVE_INFINITY : .5 * this.al * Math.log((1 - r) / (1 + r)) / this.bl, b = Math.abs(Math.cos(this.bl * l)) <= i? this.al * this.bl * l : this.al * Math.atan2(o * Math.cos(this.gamma0) + q * Math.sin(this.gamma0), Math.cos(this.bl * l)) / this.bl
                }
                return this.no_rot? (a.x = this.x0 + b, a.y = this.y0 + c) : (b -= this.uc, a.x = this.x0 + c * Math.cos(this.alpha) + b * Math.sin(this.alpha), a.y = this.y0 + b * Math.cos(this.alpha) - c * Math.sin(this.alpha)), a
            }, c.inverse = function(a){
                var b, c;
                this.no_rot? (c = a.y - this.y0, b = a.x - this.x0) : (c = (a.x - this.x0) * Math.cos(this.alpha) - (a.y - this.y0) * Math.sin(this.alpha), b = (a.y - this.y0) * Math.cos(this.alpha) + (a.x - this.x0) * Math.sin(this.alpha), b += this.uc);
                var d = Math.exp(-1 * this.bl * c / this.al), h = .5 * (d - 1 / d), j = .5 * (d + 1 / d),
                    k = Math.sin(this.bl * b / this.al),
                    l = (k * Math.cos(this.gamma0) + h * Math.sin(this.gamma0)) / j,
                    m = Math.pow(this.el / Math.sqrt((1 + l) / (1 - l)), 1 / this.bl);
                return Math.abs(l - 1) < i? (a.x = this.long0, a.y = g) : Math.abs(l + 1) < i? (a.x = this.long0, a.y = -1 * g) : (a.y = f(this.e, m), a.x = e(this.long0 - Math.atan2(h * Math.cos(this.gamma0) - k * Math.sin(this.gamma0), Math.cos(this.bl * b / this.al)) / this.bl)), a
            }, c.names = ["Hotine_Oblique_Mercator", "Hotine Oblique Mercator", "Hotine_Oblique_Mercator_Azimuth_Natural_Origin", "Hotine_Oblique_Mercator_Azimuth_Center", "omerc"]
        }, {"../common/adjust_lon": 5, "../common/phi2z": 16, "../common/tsfnz": 24}],
        56                     : [function(a, b, c){
            var d = a("../common/e0fn"), e = a("../common/e1fn"), f = a("../common/e2fn"), g = a("../common/e3fn"),
                h = a("../common/adjust_lon"), i = a("../common/adjust_lat"), j = a("../common/mlfn"), k = 1e-10,
                l = a("../common/gN"), m = 20;
            c.init = function(){
                this.temp = this.b / this.a, this.es = 1 - Math.pow(this.temp, 2), this.e = Math.sqrt(this.es), this.e0 = d(this.es), this.e1 = e(this.es), this.e2 = f(this.es), this.e3 = g(this.es), this.ml0 = this.a * j(this.e0, this.e1, this.e2, this.e3, this.lat0)
            }, c.forward = function(a){
                var b, c, d, e = a.x, f = a.y, g = h(e - this.long0);
                if(d = g * Math.sin(f), this.sphere) Math.abs(f) <= k? (b = this.a * g, c = -1 * this.a * this.lat0) : (b = this.a * Math.sin(d) / Math.tan(f), c = this.a * (i(f - this.lat0) + (1 - Math.cos(d)) / Math.tan(f)));
                else if(Math.abs(f) <= k) b = this.a * g, c = -1 * this.ml0;
                else
                {
                    var m = l(this.a, this.e, Math.sin(f)) / Math.tan(f);
                    b = m * Math.sin(d), c = this.a * j(this.e0, this.e1, this.e2, this.e3, f) - this.ml0 + m * (1 - Math.cos(d))
                }
                return a.x = b + this.x0, a.y = c + this.y0, a
            }, c.inverse = function(a){
                var b, c, d, e, f, g, i, l, n;
                if(d = a.x - this.x0, e = a.y - this.y0, this.sphere) if(Math.abs(e + this.a * this.lat0) <= k) b = h(d / this.a + this.long0), c = 0;
                else
                {
                    g = this.lat0 + e / this.a, i = d * d / this.a / this.a + g * g, l = g;
                    var o;
                    for(f = m ; f ; --f) if(o = Math.tan(l), n = -1 * (g * (l * o + 1) - l - .5 * (l * l + i) * o) / ((l - g) / o - 1), l += n, Math.abs(n) <= k)
                    {
                        c = l;
                        break
                    }
                    b = h(this.long0 + Math.asin(d * Math.tan(l) / this.a) / Math.sin(c))
                }
                else if(Math.abs(e + this.ml0) <= k) c = 0, b = h(this.long0 + d / this.a);
                else
                {
                    g = (this.ml0 + e) / this.a, i = d * d / this.a / this.a + g * g, l = g;
                    var p, q, r, s, t;
                    for(f = m ; f ; --f) if(t = this.e * Math.sin(l), p = Math.sqrt(1 - t * t) * Math.tan(l), q = this.a * j(this.e0, this.e1, this.e2, this.e3, l), r = this.e0 - 2 * this.e1 * Math.cos(2 * l) + 4 * this.e2 * Math.cos(4 * l) - 6 * this.e3 * Math.cos(6 * l), s = q / this.a, n = (g * (p * s + 1) - s - .5 * p * (s * s + i)) / (this.es * Math.sin(2 * l) * (s * s + i - 2 * g * s) / (4 * p) + (g - s) * (p * r - 2 / Math.sin(2 * l)) - r), l -= n, Math.abs(n) <= k)
                    {
                        c = l;
                        break
                    }
                    p = Math.sqrt(1 - this.es * Math.pow(Math.sin(c), 2)) * Math.tan(c), b = h(this.long0 + Math.asin(d * p / this.a) / Math.sin(c))
                }
                return a.x = b, a.y = c, a
            }, c.names = ["Polyconic", "poly"]
        }, {
            "../common/adjust_lat": 4,
            "../common/adjust_lon": 5,
            "../common/e0fn"      : 7,
            "../common/e1fn"      : 8,
            "../common/e2fn"      : 9,
            "../common/e3fn"      : 10,
            "../common/gN"        : 11,
            "../common/mlfn"      : 14
        }],
        57                     : [function(a, b, c){
            var d = a("../common/adjust_lon"), e = a("../common/adjust_lat"), f = a("../common/pj_enfn"), g = 20,
                h = a("../common/pj_mlfn"), i = a("../common/pj_inv_mlfn"), j = Math.PI / 2, k = 1e-10,
                l = a("../common/asinz");
            c.init = function(){
                this.sphere? (this.n = 1, this.m = 0, this.es = 0, this.C_y = Math.sqrt((this.m + 1) / this.n), this.C_x = this.C_y / (this.m + 1)) : this.en = f(this.es)
            }, c.forward = function(a){
                var b, c, e = a.x, f = a.y;
                if(e = d(e - this.long0), this.sphere)
                {
                    if(this.m) for(var i = this.n * Math.sin(f), j = g ; j ; --j)
                    {
                        var l = (this.m * f + Math.sin(f) - i) / (this.m + Math.cos(f));
                        if(f -= l, Math.abs(l) < k) break
                    }
                    else f = 1 !== this.n? Math.asin(this.n * Math.sin(f)) : f;
                    b = this.a * this.C_x * e * (this.m + Math.cos(f)), c = this.a * this.C_y * f
                }
                else
                {
                    var m = Math.sin(f), n = Math.cos(f);
                    c = this.a * h(f, m, n, this.en), b = this.a * e * n / Math.sqrt(1 - this.es * m * m)
                }
                return a.x = b, a.y = c, a
            }, c.inverse = function(a){
                var b, c, f, g;
                return a.x -= this.x0, f = a.x / this.a, a.y -= this.y0, b = a.y / this.a, this.sphere? (b /= this.C_y, f /= this.C_x * (this.m + Math.cos(b)), this.m? b = l((this.m * b + Math.sin(b)) / this.n) : 1 !== this.n && (b = l(Math.sin(b) / this.n)), f = d(f + this.long0), b = e(b)) : (b = i(a.y / this.a, this.es, this.en), g = Math.abs(b), j > g? (g = Math.sin(b), c = this.long0 + a.x * Math.sqrt(1 - this.es * g * g) / (this.a * Math.cos(b)), f = d(c)) : j > g - k && (f = this.long0)), a.x = f, a.y = b, a
            }, c.names = ["Sinusoidal", "sinu"]
        }, {
            "../common/adjust_lat" : 4,
            "../common/adjust_lon" : 5,
            "../common/asinz"      : 6,
            "../common/pj_enfn"    : 17,
            "../common/pj_inv_mlfn": 18,
            "../common/pj_mlfn"    : 19
        }],
        58                     : [function(a, b, c){
            c.init = function(){
                var a = this.lat0;
                this.lambda0 = this.long0;
                var b = Math.sin(a), c = this.a, d = this.rf, e = 1 / d, f = 2 * e - Math.pow(e, 2),
                    g = this.e = Math.sqrt(f);
                this.R = this.k0 * c * Math.sqrt(1 - f) / (1 - f * Math.pow(b, 2)), this.alpha = Math.sqrt(1 + f / (1 - f) * Math.pow(Math.cos(a), 4)), this.b0 = Math.asin(b / this.alpha);
                var h = Math.log(Math.tan(Math.PI / 4 + this.b0 / 2)), i = Math.log(Math.tan(Math.PI / 4 + a / 2)),
                    j = Math.log((1 + g * b) / (1 - g * b));
                this.K = h - this.alpha * i + this.alpha * g / 2 * j
            }, c.forward = function(a){
                var b = Math.log(Math.tan(Math.PI / 4 - a.y / 2)),
                    c = this.e / 2 * Math.log((1 + this.e * Math.sin(a.y)) / (1 - this.e * Math.sin(a.y))),
                    d = -this.alpha * (b + c) + this.K, e = 2 * (Math.atan(Math.exp(d)) - Math.PI / 4),
                    f = this.alpha * (a.x - this.lambda0),
                    g = Math.atan(Math.sin(f) / (Math.sin(this.b0) * Math.tan(e) + Math.cos(this.b0) * Math.cos(f))),
                    h = Math.asin(Math.cos(this.b0) * Math.sin(e) - Math.sin(this.b0) * Math.cos(e) * Math.cos(f));
                return a.y = this.R / 2 * Math.log((1 + Math.sin(h)) / (1 - Math.sin(h))) + this.y0, a.x = this.R * g + this.x0, a
            }, c.inverse = function(a){
                for(var b = a.x - this.x0, c = a.y - this.y0, d = b / this.R, e = 2 * (Math.atan(Math.exp(c / this.R)) - Math.PI / 4), f = Math.asin(Math.cos(this.b0) * Math.sin(e) + Math.sin(this.b0) * Math.cos(e) * Math.cos(d)), g = Math.atan(Math.sin(d) / (Math.cos(this.b0) * Math.cos(d) - Math.sin(this.b0) * Math.tan(e))), h = this.lambda0 + g / this.alpha, i = 0, j = f, k = -1e3, l = 0 ; Math.abs(j - k) > 1e-7 ;)
                {
                    if(++l > 20) return;
                    i = 1 / this.alpha * (Math.log(Math.tan(Math.PI / 4 + f / 2)) - this.K) + this.e * Math.log(Math.tan(Math.PI / 4 + Math.asin(this.e * Math.sin(j)) / 2)), k = j, j = 2 * Math.atan(Math.exp(i)) - Math.PI / 2
                }
                return a.x = h, a.y = j, a
            }, c.names = ["somerc"]
        }, {}],
        59                     : [function(a, b, c){
            var d = Math.PI / 2, e = 1e-10, f = a("../common/sign"), g = a("../common/msfnz"), h = a("../common/tsfnz"),
                i = a("../common/phi2z"), j = a("../common/adjust_lon");
            c.ssfn_ = function(a, b, c){
                return b *= c, Math.tan(.5 * (d + a)) * Math.pow((1 - b) / (1 + b), .5 * c)
            }, c.init = function(){
                this.coslat0 = Math.cos(this.lat0), this.sinlat0 = Math.sin(this.lat0), this.sphere? 1 === this.k0 && !isNaN(this.lat_ts) && Math.abs(this.coslat0) <= e && (this.k0 = .5 * (1 + f(this.lat0) * Math.sin(this.lat_ts))) : (Math.abs(this.coslat0) <= e && (this.con = this.lat0 > 0? 1 : -1), this.cons = Math.sqrt(Math.pow(1 + this.e, 1 + this.e) * Math.pow(1 - this.e, 1 - this.e)), 1 === this.k0 && !isNaN(this.lat_ts) && Math.abs(this.coslat0) <= e && (this.k0 = .5 * this.cons * g(this.e, Math.sin(this.lat_ts), Math.cos(this.lat_ts)) / h(this.e, this.con * this.lat_ts, this.con * Math.sin(this.lat_ts))), this.ms1 = g(this.e, this.sinlat0, this.coslat0), this.X0 = 2 * Math.atan(this.ssfn_(this.lat0, this.sinlat0, this.e)) - d, this.cosX0 = Math.cos(this.X0), this.sinX0 = Math.sin(this.X0))
            }, c.forward = function(a){
                var b, c, f, g, i, k, l = a.x, m = a.y, n = Math.sin(m), o = Math.cos(m), p = j(l - this.long0);
                return Math.abs(Math.abs(l - this.long0) - Math.PI) <= e && Math.abs(m + this.lat0) <= e? (a.x = 0 / 0, a.y = 0 / 0, a) : this.sphere? (b = 2 * this.k0 / (1 + this.sinlat0 * n + this.coslat0 * o * Math.cos(p)), a.x = this.a * b * o * Math.sin(p) + this.x0, a.y = this.a * b * (this.coslat0 * n - this.sinlat0 * o * Math.cos(p)) + this.y0, a) : (c = 2 * Math.atan(this.ssfn_(m, n, this.e)) - d, g = Math.cos(c), f = Math.sin(c), Math.abs(this.coslat0) <= e? (i = h(this.e, m * this.con, this.con * n), k = 2 * this.a * this.k0 * i / this.cons, a.x = this.x0 + k * Math.sin(l - this.long0), a.y = this.y0 - this.con * k * Math.cos(l - this.long0), a) : (Math.abs(this.sinlat0) < e? (b = 2 * this.a * this.k0 / (1 + g * Math.cos(p)), a.y = b * f) : (b = 2 * this.a * this.k0 * this.ms1 / (this.cosX0 * (1 + this.sinX0 * f + this.cosX0 * g * Math.cos(p))), a.y = b * (this.cosX0 * f - this.sinX0 * g * Math.cos(p)) + this.y0), a.x = b * g * Math.sin(p) + this.x0, a))
            }, c.inverse = function(a){
                a.x -= this.x0, a.y -= this.y0;
                var b, c, f, g, h, k = Math.sqrt(a.x * a.x + a.y * a.y);
                if(this.sphere)
                {
                    var l = 2 * Math.atan(k / (.5 * this.a * this.k0));
                    return b = this.long0, c = this.lat0, e >= k? (a.x = b, a.y = c, a) : (c = Math.asin(Math.cos(l) * this.sinlat0 + a.y * Math.sin(l) * this.coslat0 / k), b = j(Math.abs(this.coslat0) < e? this.lat0 > 0? this.long0 + Math.atan2(a.x, -1 * a.y) : this.long0 + Math.atan2(a.x, a.y) : this.long0 + Math.atan2(a.x * Math.sin(l), k * this.coslat0 * Math.cos(l) - a.y * this.sinlat0 * Math.sin(l))), a.x = b, a.y = c, a)
                }
                if(Math.abs(this.coslat0) <= e)
                {
                    if(e >= k) return c = this.lat0, b = this.long0, a.x = b, a.y = c, a;
                    a.x *= this.con, a.y *= this.con, f = k * this.cons / (2 * this.a * this.k0), c = this.con * i(this.e, f), b = this.con * j(this.con * this.long0 + Math.atan2(a.x, -1 * a.y))
                }
                else g = 2 * Math.atan(k * this.cosX0 / (2 * this.a * this.k0 * this.ms1)), b = this.long0, e >= k? h = this.X0 : (h = Math.asin(Math.cos(g) * this.sinX0 + a.y * Math.sin(g) * this.cosX0 / k), b = j(this.long0 + Math.atan2(a.x * Math.sin(g), k * this.cosX0 * Math.cos(g) - a.y * this.sinX0 * Math.sin(g)))), c = -1 * i(this.e, Math.tan(.5 * (d + h)));
                return a.x = b, a.y = c, a
            }, c.names = ["stere"]
        }, {
            "../common/adjust_lon": 5,
            "../common/msfnz"     : 15,
            "../common/phi2z"     : 16,
            "../common/sign"      : 21,
            "../common/tsfnz"     : 24
        }],
        60                     : [function(a, b, c){
            var d = a("./gauss"), e = a("../common/adjust_lon");
            c.init = function(){
                d.init.apply(this), this.rc && (this.sinc0 = Math.sin(this.phic0), this.cosc0 = Math.cos(this.phic0), this.R2 = 2 * this.rc, this.title || (this.title = "Oblique Stereographic Alternative"))
            }, c.forward = function(a){
                var b, c, f, g;
                return a.x = e(a.x - this.long0), d.forward.apply(this, [a]), b = Math.sin(a.y), c = Math.cos(a.y), f = Math.cos(a.x), g = this.k0 * this.R2 / (1 + this.sinc0 * b + this.cosc0 * c * f), a.x = g * c * Math.sin(a.x), a.y = g * (this.cosc0 * b - this.sinc0 * c * f), a.x = this.a * a.x + this.x0, a.y = this.a * a.y + this.y0, a
            }, c.inverse = function(a){
                var b, c, f, g, h;
                if(a.x = (a.x - this.x0) / this.a, a.y = (a.y - this.y0) / this.a, a.x /= this.k0, a.y /= this.k0, h = Math.sqrt(a.x * a.x + a.y * a.y))
                {
                    var i = 2 * Math.atan2(h, this.R2);
                    b = Math.sin(i), c = Math.cos(i), g = Math.asin(c * this.sinc0 + a.y * b * this.cosc0 / h), f = Math.atan2(a.x * b, h * this.cosc0 * c - a.y * this.sinc0 * b)
                }
                else g = this.phic0, f = 0;
                return a.x = f, a.y = g, d.inverse.apply(this, [a]), a.x = e(a.x + this.long0), a
            }, c.names = ["Stereographic_North_Pole", "Oblique_Stereographic", "Polar_Stereographic", "sterea", "Oblique Stereographic Alternative"]
        }, {"../common/adjust_lon": 5, "./gauss": 45}],
        61                     : [function(a, b, c){
            var d = a("../common/e0fn"), e = a("../common/e1fn"), f = a("../common/e2fn"), g = a("../common/e3fn"),
                h = a("../common/mlfn"), i = a("../common/adjust_lon"), j = Math.PI / 2, k = 1e-10,
                l = a("../common/sign"), m = a("../common/asinz");
            c.init = function(){
                this.e0 = d(this.es), this.e1 = e(this.es), this.e2 = f(this.es), this.e3 = g(this.es), this.ml0 = this.a * h(this.e0, this.e1, this.e2, this.e3, this.lat0)
            }, c.forward = function(a){
                var b, c, d, e = a.x, f = a.y, g = i(e - this.long0), j = Math.sin(f), k = Math.cos(f);
                if(this.sphere)
                {
                    var l = k * Math.sin(g);
                    if(Math.abs(Math.abs(l) - 1) < 1e-10) return 93;
                    c = .5 * this.a * this.k0 * Math.log((1 + l) / (1 - l)), b = Math.acos(k * Math.cos(g) / Math.sqrt(1 - l * l)), 0 > f && (b = -b), d = this.a * this.k0 * (b - this.lat0)
                }
                else
                {
                    var m = k * g, n = Math.pow(m, 2), o = this.ep2 * Math.pow(k, 2), p = Math.tan(f),
                        q = Math.pow(p, 2);
                    b = 1 - this.es * Math.pow(j, 2);
                    var r = this.a / Math.sqrt(b), s = this.a * h(this.e0, this.e1, this.e2, this.e3, f);
                    c = this.k0 * r * m * (1 + n / 6 * (1 - q + o + n / 20 * (5 - 18 * q + Math.pow(q, 2) + 72 * o - 58 * this.ep2))) + this.x0, d = this.k0 * (s - this.ml0 + r * p * n * (.5 + n / 24 * (5 - q + 9 * o + 4 * Math.pow(o, 2) + n / 30 * (61 - 58 * q + Math.pow(q, 2) + 600 * o - 330 * this.ep2)))) + this.y0
                }
                return a.x = c, a.y = d, a
            }, c.inverse = function(a){
                var b, c, d, e, f, g, h = 6;
                if(this.sphere)
                {
                    var n = Math.exp(a.x / (this.a * this.k0)), o = .5 * (n - 1 / n),
                        p = this.lat0 + a.y / (this.a * this.k0), q = Math.cos(p);
                    b = Math.sqrt((1 - q * q) / (1 + o * o)), f = m(b), 0 > p && (f = -f), g = 0 === o && 0 === q? this.long0 : i(Math.atan2(o, q) + this.long0)
                }
                else
                {
                    var r = a.x - this.x0, s = a.y - this.y0;
                    for(b = (this.ml0 + s / this.k0) / this.a, c = b, e = 0 ; !0 && (d = (b + this.e1 * Math.sin(2 * c) - this.e2 * Math.sin(4 * c) + this.e3 * Math.sin(6 * c)) / this.e0 - c, c += d, !(Math.abs(d) <= k)) ; e++) if(e >= h) return 95;
                    if(Math.abs(c) < j)
                    {
                        var t = Math.sin(c), u = Math.cos(c), v = Math.tan(c), w = this.ep2 * Math.pow(u, 2),
                            x = Math.pow(w, 2), y = Math.pow(v, 2), z = Math.pow(y, 2);
                        b = 1 - this.es * Math.pow(t, 2);
                        var A = this.a / Math.sqrt(b), B = A * (1 - this.es) / b, C = r / (A * this.k0),
                            D = Math.pow(C, 2);
                        f = c - A * v * D / B * (.5 - D / 24 * (5 + 3 * y + 10 * w - 4 * x - 9 * this.ep2 - D / 30 * (61 + 90 * y + 298 * w + 45 * z - 252 * this.ep2 - 3 * x))), g = i(this.long0 + C * (1 - D / 6 * (1 + 2 * y + w - D / 20 * (5 - 2 * w + 28 * y - 3 * x + 8 * this.ep2 + 24 * z))) / u)
                    }
                    else f = j * l(s), g = this.long0
                }
                return a.x = g, a.y = f, a
            }, c.names = ["Transverse_Mercator", "Transverse Mercator", "tmerc"]
        }, {
            "../common/adjust_lon": 5,
            "../common/asinz"     : 6,
            "../common/e0fn"      : 7,
            "../common/e1fn"      : 8,
            "../common/e2fn"      : 9,
            "../common/e3fn"      : 10,
            "../common/mlfn"      : 14,
            "../common/sign"      : 21
        }],
        62                     : [function(a, b, c){
            var d = .017453292519943295, e = a("./tmerc");
            c.dependsOn = "tmerc", c.init = function(){
                this.zone && (this.lat0 = 0, this.long0 = (6 * Math.abs(this.zone) - 183) * d, this.x0 = 5e5, this.y0 = this.utmSouth? 1e7 : 0, this.k0 = .9996, e.init.apply(this), this.forward = e.forward, this.inverse = e.inverse)
            }, c.names = ["Universal Transverse Mercator System", "utm"]
        }, {"./tmerc": 61}],
        63                     : [function(a, b, c){
            var d = a("../common/adjust_lon"), e = Math.PI / 2, f = 1e-10, g = a("../common/asinz");
            c.init = function(){
                this.R = this.a
            }, c.forward = function(a){
                var b, c, h = a.x, i = a.y, j = d(h - this.long0);
                Math.abs(i) <= f && (b = this.x0 + this.R * j, c = this.y0);
                var k = g(2 * Math.abs(i / Math.PI));
                (Math.abs(j) <= f || Math.abs(Math.abs(i) - e) <= f) && (b = this.x0, c = i >= 0? this.y0 + Math.PI * this.R * Math.tan(.5 * k) : this.y0 + Math.PI * this.R * -Math.tan(.5 * k));
                var l = .5 * Math.abs(Math.PI / j - j / Math.PI), m = l * l, n = Math.sin(k), o = Math.cos(k),
                    p = o / (n + o - 1), q = p * p, r = p * (2 / n - 1), s = r * r,
                    t = Math.PI * this.R * (l * (p - s) + Math.sqrt(m * (p - s) * (p - s) - (s + m) * (q - s))) / (s + m);
                0 > j && (t = -t), b = this.x0 + t;
                var u = m + p;
                return t = Math.PI * this.R * (r * u - l * Math.sqrt((s + m) * (m + 1) - u * u)) / (s + m), c = i >= 0? this.y0 + t : this.y0 - t, a.x = b, a.y = c, a
            }, c.inverse = function(a){
                var b, c, e, g, h, i, j, k, l, m, n, o, p;
                return a.x -= this.x0, a.y -= this.y0, n = Math.PI * this.R, e = a.x / n, g = a.y / n, h = e * e + g * g, i = -Math.abs(g) * (1 + h), j = i - 2 * g * g + e * e, k = -2 * i + 1 + 2 * g * g + h * h, p = g * g / k + (2 * j * j * j / k / k / k - 9 * i * j / k / k) / 27, l = (i - j * j / 3 / k) / k, m = 2 * Math.sqrt(-l / 3), n = 3 * p / l / m, Math.abs(n) > 1 && (n = n >= 0? 1 : -1), o = Math.acos(n) / 3, c = a.y >= 0? (-m * Math.cos(o + Math.PI / 3) - j / 3 / k) * Math.PI : -(-m * Math.cos(o + Math.PI / 3) - j / 3 / k) * Math.PI, b = Math.abs(e) < f? this.long0 : d(this.long0 + Math.PI * (h - 1 + Math.sqrt(1 + 2 * (e * e - g * g) + h * h)) / 2 / e), a.x = b, a.y = c, a
            }, c.names = ["Van_der_Grinten_I", "VanDerGrinten", "vandg"]
        }, {"../common/adjust_lon": 5, "../common/asinz": 6}],
        64                     : [function(a, b){
            var c = .017453292519943295, d = 57.29577951308232, e = 1, f = 2, g = a("./datum_transform"),
                h = a("./adjust_axis"), i = a("./Proj"), j = a("./common/toPoint");
            b.exports = function k(a, b, l){
                function m(a, b)
                {
                    return (a.datum.datum_type === e || a.datum.datum_type === f) && "WGS84" !== b.datumCode
                }

                var n;
                return Array.isArray(l) && (l = j(l)), a.datum && b.datum && (m(a, b) || m(b, a)) && (n = new i("WGS84"), k(a, n, l), a = n), "enu" !== a.axis && h(a, !1, l), "longlat" === a.projName? (l.x *= c, l.y *= c) : (a.to_meter && (l.x *= a.to_meter, l.y *= a.to_meter), a.inverse(l)), a.from_greenwich && (l.x += a.from_greenwich), l = g(a.datum, b.datum, l), b.from_greenwich && (l.x -= b.from_greenwich), "longlat" === b.projName? (l.x *= d, l.y *= d) : (b.forward(l), b.to_meter && (l.x /= b.to_meter, l.y /= b.to_meter)), "enu" !== b.axis && h(b, !0, l), l
            }
        }, {"./Proj": 2, "./adjust_axis": 3, "./common/toPoint": 23, "./datum_transform": 30}],
        65                     : [function(a, b){
            function c(a, b, c)
            {
                a[b] = c.map(function(a){
                    var b = {};
                    return d(a, b), b
                }).reduce(function(a, b){
                    return i(a, b)
                }, {})
            }

            function d(a, b)
            {
                var e;
                return Array.isArray(a)? (e = a.shift(), "PARAMETER" === e && (e = a.shift()), 1 === a.length? Array.isArray(a[0])? (b[e] = {}, d(a[0], b[e])) : b[e] = a[0] : a.length? "TOWGS84" === e? b[e] = a : (b[e] = {}, ["UNIT", "PRIMEM", "VERT_DATUM"].indexOf(e) > -1? (b[e] = {
                    name   : a[0].toLowerCase(),
                    convert: a[1]
                }, 3 === a.length && (b[e].auth = a[2])) : "SPHEROID" === e? (b[e] = {
                    name: a[0],
                    a   : a[1],
                    rf  : a[2]
                }, 4 === a.length && (b[e].auth = a[3])) : ["GEOGCS", "GEOCCS", "DATUM", "VERT_CS", "COMPD_CS", "LOCAL_CS", "FITTED_CS", "LOCAL_DATUM"].indexOf(e) > -1? (a[0] = ["name", a[0]], c(b, e, a)) : a.every(function(a){
                    return Array.isArray(a)
                })? c(b, e, a) : d(a, b[e])) : b[e] = !0, void 0) : void(b[a] = !0)
            }

            function e(a, b)
            {
                var c = b[0], d = b[1];
                !(c in a) && d in a && (a[c] = a[d], 3 === b.length && (a[c] = b[2](a[c])))
            }

            function f(a)
            {
                return a * h
            }

            function g(a)
            {
                function b(b)
                {
                    var c = a.to_meter || 1;
                    return parseFloat(b, 10) * c
                }

                "GEOGCS" === a.type? a.projName = "longlat" : "LOCAL_CS" === a.type? (a.projName = "identity", a.local = !0) : a.projName = "object" == typeof a.PROJECTION? Object.keys(a.PROJECTION)[0] : a.PROJECTION, a.UNIT && (a.units = a.UNIT.name.toLowerCase(), "metre" === a.units && (a.units = "meter"), a.UNIT.convert && (a.to_meter = parseFloat(a.UNIT.convert, 10))), a.GEOGCS && (a.datumCode = a.GEOGCS.DATUM? a.GEOGCS.DATUM.name.toLowerCase() : a.GEOGCS.name.toLowerCase(), "d_" === a.datumCode.slice(0, 2) && (a.datumCode = a.datumCode.slice(2)), ("new_zealand_geodetic_datum_1949" === a.datumCode || "new_zealand_1949" === a.datumCode) && (a.datumCode = "nzgd49"), "wgs_1984" === a.datumCode && ("Mercator_Auxiliary_Sphere" === a.PROJECTION && (a.sphere = !0), a.datumCode = "wgs84"), "_ferro" === a.datumCode.slice(-6) && (a.datumCode = a.datumCode.slice(0, -6)), "_jakarta" === a.datumCode.slice(-8) && (a.datumCode = a.datumCode.slice(0, -8)), ~a.datumCode.indexOf("belge") && (a.datumCode = "rnb72"), a.GEOGCS.DATUM && a.GEOGCS.DATUM.SPHEROID && (a.ellps = a.GEOGCS.DATUM.SPHEROID.name.replace("_19", "").replace(/[Cc]larke\_18/, "clrk"), "international" === a.ellps.toLowerCase().slice(0, 13) && (a.ellps = "intl"), a.a = a.GEOGCS.DATUM.SPHEROID.a, a.rf = parseFloat(a.GEOGCS.DATUM.SPHEROID.rf, 10)), ~a.datumCode.indexOf("osgb_1936") && (a.datumCode = "osgb36")), a.b && !isFinite(a.b) && (a.b = a.a);
                var c = function(b){
                        return e(a, b)
                    },
                    d = [["standard_parallel_1", "Standard_Parallel_1"], ["standard_parallel_2", "Standard_Parallel_2"], ["false_easting", "False_Easting"], ["false_northing", "False_Northing"], ["central_meridian", "Central_Meridian"], ["latitude_of_origin", "Latitude_Of_Origin"], ["latitude_of_origin", "Central_Parallel"], ["scale_factor", "Scale_Factor"], ["k0", "scale_factor"], ["latitude_of_center", "Latitude_of_center"], ["lat0", "latitude_of_center", f], ["longitude_of_center", "Longitude_Of_Center"], ["longc", "longitude_of_center", f], ["x0", "false_easting", b], ["y0", "false_northing", b], ["long0", "central_meridian", f], ["lat0", "latitude_of_origin", f], ["lat0", "standard_parallel_1", f], ["lat1", "standard_parallel_1", f], ["lat2", "standard_parallel_2", f], ["alpha", "azimuth", f], ["srsCode", "name"]];
                d.forEach(c), a.long0 || !a.longc || "Albers_Conic_Equal_Area" !== a.PROJECTION && "Lambert_Azimuthal_Equal_Area" !== a.PROJECTION || (a.long0 = a.longc)
            }

            var h = .017453292519943295, i = a("./extend");
            b.exports = function(a, b){
                var c = JSON.parse(("," + a).replace(/\s*\,\s*([A-Z_0-9]+?)(\[)/g, ',["$1",').slice(1).replace(/\s*\,\s*([A-Z_0-9]+?)\]/g, ',"$1"]').replace(/,\["VERTCS".+/, "")),
                    e = c.shift(), f = c.shift();
                c.unshift(["name", f]), c.unshift(["type", e]), c.unshift("output");
                var h = {};
                return d(c, h), g(h.output), i(b, h.output)
            }
        }, {"./extend": 33}],
        66                     : [function(a, b, c){
            function d(a)
            {
                return a * (Math.PI / 180)
            }

            function e(a)
            {
                return 180 * (a / Math.PI)
            }

            function f(a)
            {
                var b, c, e, f, g, i, j, k, l, m = a.lat, n = a.lon, o = 6378137, p = .00669438, q = .9996, r = d(m),
                    s = d(n);
                l = Math.floor((n + 180) / 6) + 1, 180 === n && (l = 60), m >= 56 && 64 > m && n >= 3 && 12 > n && (l = 32), m >= 72 && 84 > m && (n >= 0 && 9 > n? l = 31 : n >= 9 && 21 > n? l = 33 : n >= 21 && 33 > n? l = 35 : n >= 33 && 42 > n && (l = 37)), b = 6 * (l - 1) - 180 + 3, k = d(b), c = p / (1 - p), e = o / Math.sqrt(1 - p * Math.sin(r) * Math.sin(r)), f = Math.tan(r) * Math.tan(r), g = c * Math.cos(r) * Math.cos(r), i = Math.cos(r) * (s - k), j = o * ((1 - p / 4 - 3 * p * p / 64 - 5 * p * p * p / 256) * r - (3 * p / 8 + 3 * p * p / 32 + 45 * p * p * p / 1024) * Math.sin(2 * r) + (15 * p * p / 256 + 45 * p * p * p / 1024) * Math.sin(4 * r) - 35 * p * p * p / 3072 * Math.sin(6 * r));
                var t = q * e * (i + (1 - f + g) * i * i * i / 6 + (5 - 18 * f + f * f + 72 * g - 58 * c) * i * i * i * i * i / 120) + 5e5,
                    u = q * (j + e * Math.tan(r) * (i * i / 2 + (5 - f + 9 * g + 4 * g * g) * i * i * i * i / 24 + (61 - 58 * f + f * f + 600 * g - 330 * c) * i * i * i * i * i * i / 720));
                return 0 > m && (u += 1e7), {
                    northing  : Math.round(u),
                    easting   : Math.round(t),
                    zoneNumber: l,
                    zoneLetter: h(m)
                }
            }

            function g(a)
            {
                var b = a.northing, c = a.easting, d = a.zoneLetter, f = a.zoneNumber;
                if(0 > f || f > 60) return null;
                var h, i, j, k, l, m, n, o, p, q, r = .9996, s = 6378137, t = .00669438,
                    u = (1 - Math.sqrt(1 - t)) / (1 + Math.sqrt(1 - t)), v = c - 5e5, w = b;
                "N" > d && (w -= 1e7), o = 6 * (f - 1) - 180 + 3, h = t / (1 - t), n = w / r, p = n / (s * (1 - t / 4 - 3 * t * t / 64 - 5 * t * t * t / 256)), q = p + (3 * u / 2 - 27 * u * u * u / 32) * Math.sin(2 * p) + (21 * u * u / 16 - 55 * u * u * u * u / 32) * Math.sin(4 * p) + 151 * u * u * u / 96 * Math.sin(6 * p), i = s / Math.sqrt(1 - t * Math.sin(q) * Math.sin(q)), j = Math.tan(q) * Math.tan(q), k = h * Math.cos(q) * Math.cos(q), l = s * (1 - t) / Math.pow(1 - t * Math.sin(q) * Math.sin(q), 1.5), m = v / (i * r);
                var x = q - i * Math.tan(q) / l * (m * m / 2 - (5 + 3 * j + 10 * k - 4 * k * k - 9 * h) * m * m * m * m / 24 + (61 + 90 * j + 298 * k + 45 * j * j - 252 * h - 3 * k * k) * m * m * m * m * m * m / 720);
                x = e(x);
                var y = (m - (1 + 2 * j + k) * m * m * m / 6 + (5 - 2 * k + 28 * j - 3 * k * k + 8 * h + 24 * j * j) * m * m * m * m * m / 120) / Math.cos(q);
                y = o + e(y);
                var z;
                if(a.accuracy)
                {
                    var A = g({
                        northing  : a.northing + a.accuracy,
                        easting   : a.easting + a.accuracy,
                        zoneLetter: a.zoneLetter,
                        zoneNumber: a.zoneNumber
                    });
                    z = {top: A.lat, right: A.lon, bottom: x, left: y}
                }
                else z = {lat: x, lon: y};
                return z
            }

            function h(a)
            {
                var b = "Z";
                return 84 >= a && a >= 72? b = "X" : 72 > a && a >= 64? b = "W" : 64 > a && a >= 56? b = "V" : 56 > a && a >= 48? b = "U" : 48 > a && a >= 40? b = "T" : 40 > a && a >= 32? b = "S" : 32 > a && a >= 24? b = "R" : 24 > a && a >= 16? b = "Q" : 16 > a && a >= 8? b = "P" : 8 > a && a >= 0? b = "N" : 0 > a && a >= -8? b = "M" : -8 > a && a >= -16? b = "L" : -16 > a && a >= -24? b = "K" : -24 > a && a >= -32? b = "J" : -32 > a && a >= -40? b = "H" : -40 > a && a >= -48? b = "G" : -48 > a && a >= -56? b = "F" : -56 > a && a >= -64? b = "E" : -64 > a && a >= -72? b = "D" : -72 > a && a >= -80 && (b = "C"), b
            }

            function i(a, b)
            {
                var c = "" + a.easting, d = "" + a.northing;
                return a.zoneNumber + a.zoneLetter + j(a.easting, a.northing, a.zoneNumber) + c.substr(c.length - 5, b) + d.substr(d.length - 5, b)
            }

            function j(a, b, c)
            {
                var d = k(c), e = Math.floor(a / 1e5), f = Math.floor(b / 1e5) % 20;
                return l(e, f, d)
            }

            function k(a)
            {
                var b = a % q;
                return 0 === b && (b = q), b
            }

            function l(a, b, c)
            {
                var d = c - 1, e = r.charCodeAt(d), f = s.charCodeAt(d), g = e + a - 1, h = f + b, i = !1;
                g > x && (g = g - x + t - 1, i = !0), (g === u || u > e && g > u || (g > u || u > e) && i) && g++, (g === v || v > e && g > v || (g > v || v > e) && i) && (g++, g === u && g++), g > x && (g = g - x + t - 1), h > w? (h = h - w + t - 1, i = !0) : i = !1, (h === u || u > f && h > u || (h > u || u > f) && i) && h++, (h === v || v > f && h > v || (h > v || v > f) && i) && (h++, h === u && h++), h > w && (h = h - w + t - 1);
                var j = String.fromCharCode(g) + String.fromCharCode(h);
                return j
            }

            function m(a)
            {
                if(a && 0 === a.length) throw"MGRSPoint coverting from nothing";
                for(var b, c = a.length, d = null, e = "", f = 0 ; !/[A-Z]/.test(b = a.charAt(f)) ;)
                {
                    if(f >= 2) throw"MGRSPoint bad conversion from: " + a;
                    e += b, f++
                }
                var g = parseInt(e, 10);
                if(0 === f || f + 3 > c) throw"MGRSPoint bad conversion from: " + a;
                var h = a.charAt(f++);
                if("A" >= h || "B" === h || "Y" === h || h >= "Z" || "I" === h || "O" === h) throw"MGRSPoint zone letter " + h + " not handled: " + a;
                d = a.substring(f, f += 2);
                for(var i = k(g), j = n(d.charAt(0), i), l = o(d.charAt(1), i) ; l < p(h) ;) l += 2e6;
                var m = c - f;
                if(m % 2 !== 0) throw"MGRSPoint has to have an even number \nof digits after the zone letter and two 100km letters - front \nhalf for easting meters, second half for \nnorthing meters" + a;
                var q, r, s, t, u, v = m / 2, w = 0, x = 0;
                return v > 0 && (q = 1e5 / Math.pow(10, v), r = a.substring(f, f + v), w = parseFloat(r) * q, s = a.substring(f + v), x = parseFloat(s) * q), t = w + j, u = x + l, {
                    easting   : t,
                    northing  : u,
                    zoneLetter: h,
                    zoneNumber: g,
                    accuracy  : q
                }
            }

            function n(a, b)
            {
                for(var c = r.charCodeAt(b - 1), d = 1e5, e = !1 ; c !== a.charCodeAt(0) ;)
                {
                    if(c++, c === u && c++, c === v && c++, c > x)
                    {
                        if(e) throw"Bad character: " + a;
                        c = t, e = !0
                    }
                    d += 1e5
                }
                return d
            }

            function o(a, b)
            {
                if(a > "V") throw"MGRSPoint given invalid Northing " + a;
                for(var c = s.charCodeAt(b - 1), d = 0, e = !1 ; c !== a.charCodeAt(0) ;)
                {
                    if(c++, c === u && c++, c === v && c++, c > w)
                    {
                        if(e) throw"Bad character: " + a;
                        c = t, e = !0
                    }
                    d += 1e5
                }
                return d
            }

            function p(a)
            {
                var b;
                switch(a)
                {
                    case"C":
                        b = 11e5;
                        break;
                    case"D":
                        b = 2e6;
                        break;
                    case"E":
                        b = 28e5;
                        break;
                    case"F":
                        b = 37e5;
                        break;
                    case"G":
                        b = 46e5;
                        break;
                    case"H":
                        b = 55e5;
                        break;
                    case"J":
                        b = 64e5;
                        break;
                    case"K":
                        b = 73e5;
                        break;
                    case"L":
                        b = 82e5;
                        break;
                    case"M":
                        b = 91e5;
                        break;
                    case"N":
                        b = 0;
                        break;
                    case"P":
                        b = 8e5;
                        break;
                    case"Q":
                        b = 17e5;
                        break;
                    case"R":
                        b = 26e5;
                        break;
                    case"S":
                        b = 35e5;
                        break;
                    case"T":
                        b = 44e5;
                        break;
                    case"U":
                        b = 53e5;
                        break;
                    case"V":
                        b = 62e5;
                        break;
                    case"W":
                        b = 7e6;
                        break;
                    case"X":
                        b = 79e5;
                        break;
                    default:
                        b = -1
                }
                if(b >= 0) return b;
                throw"Invalid zone letter: " + a
            }

            var q = 6, r = "AJSAJS", s = "AFAFAF", t = 65, u = 73, v = 79, w = 86, x = 90;
            c.forward = function(a, b){
                return b = b || 5, i(f({lat: a[1], lon: a[0]}), b)
            }, c.inverse = function(a){
                var b = g(m(a.toUpperCase()));
                return [b.left, b.bottom, b.right, b.top]
            }, c.toPoint = function(a){
                var b = c.inverse(a);
                return [(b[2] + b[0]) / 2, (b[3] + b[1]) / 2]
            }
        }, {}],
        67                     : [function(a, b){
            b.exports = {
                name           : "proj4",
                version        : "2.3.3",
                description    : "Proj4js is a JavaScript library to transform point coordinates from one coordinate system to another, including datum transformations.",
                main           : "lib/index.js",
                directories    : {test: "test", doc: "docs"},
                scripts        : {test: "./node_modules/istanbul/lib/cli.js test ./node_modules/mocha/bin/_mocha test/test.js"},
                repository     : {type: "git", url: "git://github.com/proj4js/proj4js.git"},
                author         : "",
                license        : "MIT",
                jam            : {
                    main   : "dist/proj4.js",
                    include: ["dist/proj4.js", "README.md", "AUTHORS", "LICENSE.md"]
                },
                devDependencies: {
                    "grunt-cli"            : "~0.1.13",
                    grunt                  : "~0.4.2",
                    "grunt-contrib-connect": "~0.6.0",
                    "grunt-contrib-jshint" : "~0.8.0",
                    chai                   : "~1.8.1",
                    mocha                  : "~1.17.1",
                    "grunt-mocha-phantomjs": "~0.4.0",
                    browserify             : "~3.24.5",
                    "grunt-browserify"     : "~1.3.0",
                    "grunt-contrib-uglify" : "~0.3.2",
                    curl                   : "git://github.com/cujojs/curl.git",
                    istanbul               : "~0.2.4",
                    tin                    : "~0.4.0"
                },
                dependencies   : {mgrs: "0.0.0"}
            }
        }, {}],
        "./includedProjections": [function(a, b){
            b.exports = a("gWUPNW")
        }, {}],
        gWUPNW                 : [function(a, b){
            var c = [a("./lib/projections/tmerc"), a("./lib/projections/utm"), a("./lib/projections/sterea"), a("./lib/projections/stere"), a("./lib/projections/somerc"), a("./lib/projections/omerc"), a("./lib/projections/lcc"), a("./lib/projections/krovak"), a("./lib/projections/cass"), a("./lib/projections/laea"), a("./lib/projections/aea"), a("./lib/projections/gnom"), a("./lib/projections/cea"), a("./lib/projections/eqc"), a("./lib/projections/poly"), a("./lib/projections/nzmg"), a("./lib/projections/mill"), a("./lib/projections/sinu"), a("./lib/projections/moll"), a("./lib/projections/eqdc"), a("./lib/projections/vandg"), a("./lib/projections/aeqd")];
            b.exports = function(proj4){
                c.forEach(function(a){
                    proj4.Proj.projections.add(a)
                })
            }
        }, {
            "./lib/projections/aea"   : 39,
            "./lib/projections/aeqd"  : 40,
            "./lib/projections/cass"  : 41,
            "./lib/projections/cea"   : 42,
            "./lib/projections/eqc"   : 43,
            "./lib/projections/eqdc"  : 44,
            "./lib/projections/gnom"  : 46,
            "./lib/projections/krovak": 47,
            "./lib/projections/laea"  : 48,
            "./lib/projections/lcc"   : 49,
            "./lib/projections/mill"  : 52,
            "./lib/projections/moll"  : 53,
            "./lib/projections/nzmg"  : 54,
            "./lib/projections/omerc" : 55,
            "./lib/projections/poly"  : 56,
            "./lib/projections/sinu"  : 57,
            "./lib/projections/somerc": 58,
            "./lib/projections/stere" : 59,
            "./lib/projections/sterea": 60,
            "./lib/projections/tmerc" : 61,
            "./lib/projections/utm"   : 62,
            "./lib/projections/vandg" : 63
        }]
    }, {}, [35])(35)
});

//heatmap
(function(w){
    var heatmapFactory = (function(){
        var store = function store(hmap){
            var _ = {data: [], heatmap: hmap};
            this.max = 1;
            this.get = function(key){
                return _[key]
            };
            this.set = function(key, value){
                _[key] = value
            }
        };
        store.prototype = {
            addDataPoint            : function(x, y){
                if(x < 0 || y < 0)
                {
                    return
                }
                var me = this, heatmap = me.get("heatmap"), data = me.get("data");
                if(!data[x])
                {
                    data[x] = []
                }
                if(!data[x][y])
                {
                    data[x][y] = 0
                }
                data[x][y] += (arguments.length < 3)? 1 : arguments[2];
                me.set("data", data);
                if(me.max < data[x][y])
                {
                    heatmap.get("actx").clearRect(0, 0, heatmap.get("width"), heatmap.get("height"));
                    me.setDataSet({max: data[x][y], data: data}, true);
                    return
                }
                heatmap.drawAlpha(x, y, data[x][y], true)
            }, setDataSet           : function(obj, internal){
                var me = this, heatmap = me.get("heatmap"), data = [], d = obj.data, dlen = d.length;
                heatmap.clear();
                this.max = obj.max;
                heatmap.get("legend") && heatmap.get("legend").update(obj.max);
                if(internal != null && internal)
                {
                    for(var one in d)
                    {
                        if(one === undefined)
                        {
                            continue
                        }
                        for(var two in d[one])
                        {
                            if(two === undefined)
                            {
                                continue
                            }
                            heatmap.drawAlpha(one, two, d[one][two], false)
                        }
                    }
                }
                else
                {
                    while(dlen--)
                    {
                        var point = d[dlen];
                        heatmap.drawAlpha(point.x, point.y, point.count, false);
                        if(!data[point.x])
                        {
                            data[point.x] = []
                        }
                        if(!data[point.x][point.y])
                        {
                            data[point.x][point.y] = 0
                        }
                        data[point.x][point.y] = point.count
                    }
                }
                heatmap.colorize();
                this.set("data", d)
            }, exportDataSet        : function(){
                var me = this, data = me.get("data"), exportData = [];
                for(var one in data)
                {
                    if(one === undefined)
                    {
                        continue
                    }
                    for(var two in data[one])
                    {
                        if(two === undefined)
                        {
                            continue
                        }
                        exportData.push({x: parseInt(one, 10), y: parseInt(two, 10), count: data[one][two]})
                    }
                }
                return {max: me.max, data: exportData}
            }, generateRandomDataSet: function(points){
                var heatmap = this.get("heatmap"), w = heatmap.get("width"), h = heatmap.get("height");
                var randomset = {}, max = Math.floor(Math.random() * 1000 + 1);
                randomset.max = max;
                var data = [];
                while(points--)
                {
                    data.push({
                        x    : Math.floor(Math.random() * w + 1),
                        y    : Math.floor(Math.random() * h + 1),
                        count: Math.floor(Math.random() * max + 1)
                    })
                }
                randomset.data = data;
                this.setDataSet(randomset)
            }
        };
        var legend = function legend(config){
            this.config = config;
            var _ = {element: null, labelsEl: null, gradientCfg: null, ctx: null};
            this.get = function(key){
                return _[key]
            };
            this.set = function(key, value){
                _[key] = value
            };
            this.init()
        };
        legend.prototype = {
            init                    : function(){
                var me = this, config = me.config, title = config.title || "Legend", position = config.position,
                    offset = config.offset || 10, gconfig = config.gradient, labelsEl = document.createElement("ul"),
                    labelsHtml = "", grad, element, gradient, positionCss = "";
                me.processGradientObject();
                if(position.indexOf("t") > -1)
                {
                    positionCss += "top:" + offset + "px;"
                }
                else
                {
                    positionCss += "bottom:" + offset + "px;"
                }
                if(position.indexOf("l") > -1)
                {
                    positionCss += "left:" + offset + "px;"
                }
                else
                {
                    positionCss += "right:" + offset + "px;"
                }
                element = document.createElement("div");
                element.style.cssText = "border-radius:5px;position:absolute;" + positionCss + "font-family:Helvetica; width:256px;z-index:10000000000; background:rgba(255,255,255,1);padding:10px;border:1px solid black;margin:0;";
                element.innerHTML = "<h3 style='padding:0;margin:0;text-align:center;font-size:16px;'>" + title + "</h3>";
                labelsEl.style.cssText = "position:relative;font-size:12px;display:block;list-style:none;list-style-type:none;margin:0;height:15px;";
                gradient = document.createElement("div");
                gradient.style.cssText = ["position:relative;display:block;width:256px;height:15px;border-bottom:1px solid black; background-image:url(", me.createGradientImage(), ");"].join("");
                element.appendChild(labelsEl);
                element.appendChild(gradient);
                me.set("element", element);
                me.set("labelsEl", labelsEl);
                me.update(1)
            }, processGradientObject: function(){
                var me = this, gradientConfig = this.config.gradient, gradientArr = [];
                for(var key in gradientConfig)
                {
                    if(gradientConfig.hasOwnProperty(key))
                    {
                        gradientArr.push({stop: key, value: gradientConfig[key]})
                    }
                }
                gradientArr.sort(function(a, b){
                    return (a.stop - b.stop)
                });
                gradientArr.unshift({stop: 0, value: "rgba(0,0,0,0)"});
                me.set("gradientArr", gradientArr)
            }, createGradientImage  : function(){
                var me = this, gradArr = me.get("gradientArr"), length = gradArr.length,
                    canvas = document.createElement("canvas"), ctx = canvas.getContext("2d"), grad;
                canvas.width = "256";
                canvas.height = "15";
                grad = ctx.createLinearGradient(0, 5, 256, 10);
                for(var i = 0 ; i < length ; i++)
                {
                    grad.addColorStop(1 / (length - 1) * i, gradArr[i].value)
                }
                ctx.fillStyle = grad;
                ctx.fillRect(0, 5, 256, 10);
                ctx.strokeStyle = "black";
                ctx.beginPath();
                for(var i = 0 ; i < length ; i++)
                {
                    ctx.moveTo(((1 / (length - 1) * i * 256) >> 0) + 0.5, 0);
                    ctx.lineTo(((1 / (length - 1) * i * 256) >> 0) + 0.5, (i == 0)? 15 : 5)
                }
                ctx.moveTo(255.5, 0);
                ctx.lineTo(255.5, 15);
                ctx.moveTo(255.5, 4.5);
                ctx.lineTo(0, 4.5);
                ctx.stroke();
                me.set("ctx", ctx);
                return canvas.toDataURL()
            }, getElement           : function(){
                return this.get("element")
            }, update               : function(max){
                var me = this, gradient = me.get("gradientArr"), ctx = me.get("ctx"), labels = me.get("labelsEl"),
                    labelText, labelsHtml = "", offset;
                for(var i = 0 ; i < gradient.length ; i++)
                {
                    labelText = max * gradient[i].stop >> 0;
                    offset = (ctx.measureText(labelText).width / 2) >> 0;
                    if(i == 0)
                    {
                        offset = 0
                    }
                    if(i == gradient.length - 1)
                    {
                        offset *= 2
                    }
                    labelsHtml += '<li style="position:absolute;left:' + (((((1 / (gradient.length - 1) * i * 256) || 0)) >> 0) - offset + 0.5) + 'px">' + labelText + "</li>"
                }
                labels.innerHTML = labelsHtml
            }
        };
        var heatmap = function heatmap(config){
            var _ = {
                radius          : 40,
                element         : {},
                canvas          : {},
                acanvas         : {},
                ctx             : {},
                actx            : {},
                legend          : null,
                visible         : true,
                width           : 0,
                height          : 0,
                max             : false,
                gradient        : false,
                opacity         : 180,
                premultiplyAlpha: false,
                bounds          : {l: 1000, r: 0, t: 1000, b: 0},
                debug           : false
            };
            this.store = new store(this);
            this.get = function(key){
                return _[key]
            };
            this.set = function(key, value){
                _[key] = value
            };
            this.configure(config);
            this.init()
        };
        heatmap.prototype = {
            configure          : function(config){
                var me = this, rout, rin;
                me.set("radius", config.radius || 40);
                me.set("element", (config.element instanceof Object)? config.element : document.getElementById(config.element));
                me.set("visible", (config.visible != null)? config.visible : true);
                me.set("max", config.max || false);
                me.set("gradient", config.gradient || {
                    0.45: "rgb(0,0,255)",
                    0.55: "rgb(0,255,255)",
                    0.65: "rgb(0,255,0)",
                    0.95: "yellow",
                    1   : "rgb(255,0,0)"
                });
                me.set("opacity", parseInt(255 / (100 / config.opacity), 10) || 180);
                me.set("width", config.width || 0);
                me.set("height", config.height || 0);
                me.set("debug", config.debug);
                if(config.legend)
                {
                    var legendCfg = config.legend;
                    legendCfg.gradient = me.get("gradient");
                    me.set("legend", new legend(legendCfg))
                }
            }, resize          : function(){
                var me = this, element = me.get("element"), canvas = me.get("canvas"), acanvas = me.get("acanvas");
                canvas.width = acanvas.width = me.get("width") || element.style.width.replace(/px/, "") || me.getWidth(element);
                this.set("width", canvas.width);
                canvas.height = acanvas.height = me.get("height") || element.style.height.replace(/px/, "") || me.getHeight(element);
                this.set("height", canvas.height)
            }, init            : function(){
                var me = this, canvas = document.createElement("canvas"), acanvas = document.createElement("canvas"),
                    ctx = canvas.getContext("2d"), actx = acanvas.getContext("2d"), element = me.get("element");
                me.initColorPalette();
                me.set("canvas", canvas);
                me.set("ctx", ctx);
                me.set("acanvas", acanvas);
                me.set("actx", actx);
                me.resize();
                canvas.style.cssText = acanvas.style.cssText = "position:absolute;top:0;left:0;z-index:10000000;";
                if(!me.get("visible"))
                {
                    canvas.style.display = "none"
                }
                element.appendChild(canvas);
                if(me.get("legend"))
                {
                    element.appendChild(me.get("legend").getElement())
                }
                if(me.get("debug"))
                {
                    document.body.appendChild(acanvas)
                }
                actx.shadowOffsetX = 15000;
                actx.shadowOffsetY = 15000;
                actx.shadowBlur = 15
            }, initColorPalette: function(){
                var me = this, canvas = document.createElement("canvas"), gradient = me.get("gradient"), ctx, grad,
                    testData;
                canvas.width = "1";
                canvas.height = "256";
                ctx = canvas.getContext("2d");
                grad = ctx.createLinearGradient(0, 0, 1, 256);
                testData = ctx.getImageData(0, 0, 1, 1);
                testData.data[0] = testData.data[3] = 64;
                testData.data[1] = testData.data[2] = 0;
                ctx.putImageData(testData, 0, 0);
                testData = ctx.getImageData(0, 0, 1, 1);
                me.set("premultiplyAlpha", (testData.data[0] < 60 || testData.data[0] > 70));
                for(var x in gradient)
                {
                    grad.addColorStop(x, gradient[x])
                }
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, 1, 256);
                me.set("gradient", ctx.getImageData(0, 0, 1, 256).data)
            }, getWidth        : function(element){
                var width = element.offsetWidth;
                if(element.style.paddingLeft)
                {
                    width += element.style.paddingLeft
                }
                if(element.style.paddingRight)
                {
                    width += element.style.paddingRight
                }
                return width
            }, getHeight       : function(element){
                var height = element.offsetHeight;
                if(element.style.paddingTop)
                {
                    height += element.style.paddingTop
                }
                if(element.style.paddingBottom)
                {
                    height += element.style.paddingBottom
                }
                return height
            }, colorize        : function(x, y){
                var me = this, width = me.get("width"), radius = me.get("radius"), height = me.get("height"),
                    actx = me.get("actx"), ctx = me.get("ctx"), x2 = radius * 3,
                    premultiplyAlpha = me.get("premultiplyAlpha"), palette = me.get("gradient"),
                    opacity = me.get("opacity"), bounds = me.get("bounds"), left, top, bottom, right, image, imageData,
                    length, alpha, offset, finalAlpha;
                if(x != null && y != null)
                {
                    if(x + x2 > width)
                    {
                        x = width - x2
                    }
                    if(x < 0)
                    {
                        x = 0
                    }
                    if(y < 0)
                    {
                        y = 0
                    }
                    if(y + x2 > height)
                    {
                        y = height - x2
                    }
                    left = x;
                    top = y;
                    right = x + x2;
                    bottom = y + x2
                }
                else
                {
                    if(bounds.l < 0)
                    {
                        left = 0
                    }
                    else
                    {
                        left = bounds.l
                    }
                    if(bounds.r > width)
                    {
                        right = width
                    }
                    else
                    {
                        right = bounds.r
                    }
                    if(bounds.t < 0)
                    {
                        top = 0
                    }
                    else
                    {
                        top = bounds.t
                    }
                    if(bounds.b > height)
                    {
                        bottom = height
                    }
                    else
                    {
                        bottom = bounds.b
                    }
                }
                image = actx.getImageData(left, top, right - left, bottom - top);
                imageData = image.data;
                length = imageData.length;
                for(var i = 3 ; i < length ; i += 4)
                {
                    alpha = imageData[i], offset = alpha * 4;
                    if(!offset)
                    {
                        continue
                    }
                    finalAlpha = (alpha < opacity)? alpha : opacity;
                    imageData[i - 3] = palette[offset];
                    imageData[i - 2] = palette[offset + 1];
                    imageData[i - 1] = palette[offset + 2];
                    if(premultiplyAlpha)
                    {
                        imageData[i - 3] /= 255 / finalAlpha;
                        imageData[i - 2] /= 255 / finalAlpha;
                        imageData[i - 1] /= 255 / finalAlpha
                    }
                    imageData[i] = finalAlpha
                }
                image.data = imageData;
                ctx.putImageData(image, left, top)
            }, drawAlpha       : function(x, y, count, colorize){
                var me = this, radius = me.get("radius"), ctx = me.get("actx"), max = me.get("max"),
                    bounds = me.get("bounds"), xb = x - (1.5 * radius) >> 0, yb = y - (1.5 * radius) >> 0,
                    xc = x + (1.5 * radius) >> 0, yc = y + (1.5 * radius) >> 0;
                ctx.shadowColor = ("rgba(0,0,0," + ((count)? (count / me.store.max) : "0.1") + ")");
                ctx.shadowOffsetX = 15000;
                ctx.shadowOffsetY = 15000;
                ctx.shadowBlur = 15;
                ctx.beginPath();
                ctx.arc(x - 15000, y - 15000, radius, 0, Math.PI * 2, true);
                ctx.closePath();
                ctx.fill();
                if(colorize)
                {
                    me.colorize(xb, yb)
                }
                else
                {
                    if(xb < bounds.l)
                    {
                        bounds.l = xb
                    }
                    if(yb < bounds.t)
                    {
                        bounds.t = yb
                    }
                    if(xc > bounds.r)
                    {
                        bounds.r = xc
                    }
                    if(yc > bounds.b)
                    {
                        bounds.b = yc
                    }
                }
            }, toggleDisplay   : function(){
                var me = this, visible = me.get("visible"), canvas = me.get("canvas");
                if(!visible)
                {
                    canvas.style.display = "block"
                }
                else
                {
                    canvas.style.display = "none"
                }
                me.set("visible", !visible)
            }, getImageData    : function(){
                return this.get("canvas").toDataURL()
            }, getImage        : function(){
                return this.get("canvas")
            }, clear           : function(){
                var me = this, w = me.get("width"), h = me.get("height");
                me.store.set("data", []);
                me.get("ctx").clearRect(0, 0, w, h);
                me.get("actx").clearRect(0, 0, w, h)
            }, cleanup         : function(){
                var me = this;
                me.get("element").removeChild(me.get("canvas"))
            }
        };
        return {
            create : function(config){
                return new heatmap(config)
            }, util: {
                mousePosition: function(ev){
                    var x, y;
                    if(ev.layerX)
                    {
                        x = ev.layerX;
                        y = ev.layerY
                    }
                    else
                    {
                        if(ev.offsetX)
                        {
                            x = ev.offsetX;
                            y = ev.offsetY
                        }
                    }
                    if(typeof(x) == "undefined")
                    {
                        return
                    }
                    return [x, y]
                }
            }
        }
    })();
    w.h337 = w.heatmapFactory = heatmapFactory
})(window);

//uEditor
(function(e){
    var t = t || null;
    var n = n || null;
    var r = r || null;
    var i = i || null;
    e.removeDuplicate = function(e){
        if(!(e instanceof Array)) return;
        e:for(var t = 0 ; t < e.length ; t++)
        {
            for(var n = 0 ; n < e.length ; n++)
            {
                if(n == t) continue;
                if(e[n] == e[t])
                {
                    e = e.slice(n);
                    continue e
                }
            }
        }
        return e
    };
    e.extend(e.expr[":"], {
        inline: function(t){
            return e(t).is("a") || e(t).is("em") || e(t).is("font") || e(t).is("span") || e(t).is("strong") || e(t).is("u")
        }
    });
    var s = function(r, i){
        e.extend(this, {
            settings             : i, createDOM: function(){
                this.textarea = r;
                this.container = document.createElement("div");
                this.iframe = document.createElement("iframe");
                this.input = document.createElement("input");
                e(this.input).attr({
                    type : "hidden",
                    name : e(this.textarea).attr("name"),
                    value: e(this.textarea).attr("value")
                });
                e(this.textarea).addClass("uEditorTextarea");
                e(this.textarea).attr("name", e(this.textarea).attr("name") + "uEditorTextarea");
                e(this.textarea).hide();
                e(this.container).addClass(i.containerClass);
                e(this.iframe).addClass("uEditorIframe");
                this.toolbar = new o(this);
                e(this.container).append(this.toolbar.itemsList);
                e(this.container).append(this.iframe);
                e(this.container).append(this.input);
                e(this.container).hide();
                this.input.uEditorObject = this;
                e(this.textarea).replaceWith(this.container)
            }, writeDocument     : function(){
                var t = '					<html>						<head>							INSERT:STYLESHEET:END						</head>						<body id="iframeBody">							INSERT:CONTENT:END						</body>					</html>				';
                t = e.browser.msie? t.replace(/INSERT:STYLESHEET:END/, '<link rel="stylesheet" type="text/css" href="' + this.uEditorStylesheet + '"></link>') : t.replace(/INSERT:STYLESHEET:END/, "");
                t = t.replace(/INSERT:CONTENT:END/, e(this.input).val());
                this.iframe.contentWindow.document.open();
                this.iframe.contentWindow.document.write(t);
                this.iframe.contentWindow.document.close();
                if(!e.browser.msie) e(this.iframe.contentWindow.document).find("head").append(e(this.iframe.contentWindow.document.createElement("link")).attr({
                    rel : "stylesheet",
                    type: "text/css",
                    href: i.stylesheet
                }))
            }, convertSPANs      : function(r){
                var i = this.iframe;
                if(r)
                {
                    var s = e(this.iframe.contentWindow.document).find("span");
                    if(s.length) s.each(function(){
                        var r = e(this).contents();
                        var s = null;
                        var o = null;
                        var u = e(this).attr("style").replace(/\s*/gi, "");
                        switch(u)
                        {
                            case"font-style:italic;":
                                o = s = i.contentWindow.document.createElement("em");
                                break;
                            case"font-weight:bold;":
                                o = s = i.contentWindow.document.createElement("strong");
                                break;
                            case"font-weight:bold;font-style:italic;":
                                t = i.contentWindow.document.createElement("em");
                                n = i.contentWindow.document.createElement("strong");
                                e(t).append(n);
                                o = t;
                                s = n;
                                break;
                            case"font-style:italic;font-weight:bold;":
                                t = i.contentWindow.document.createElement("em");
                                n = i.contentWindow.document.createElement("strong");
                                e(t).append(n);
                                o = t;
                                s = n;
                                break;
                            default:
                                break
                        }
                        r.each(function(){
                            e(s).append(this)
                        });
                        e(this).before(o);
                        e(this).remove()
                    })
                }
                else
                {
                    e(i.contentWindow.document).find("em").each(function(){
                        var t = e(this).contents();
                        var n = i.contentWindow.document.createElement("span");
                        e(n).css("font-style", "italic");
                        t.each(function(){
                            e(n).append(this)
                        });
                        e(this).replaceWith(n)
                    });
                    e(i.contentWindow.document).find("strong").each(function(){
                        var t = e(this).contents();
                        var n = i.contentWindow.document.createElement("span");
                        e(n).css("font-weight", "bold");
                        t.each(function(){
                            e(n).append(this)
                        });
                        e(this).replaceWith(n)
                    })
                }
            }, makeEditable      : function(){
                var t = this;
                try
                {
                    this.iframe.contentWindow.document.designMode = "on"
                }
                catch(n)
                {
                    setTimeout(function(){
                        t.makeEditable()
                    }, 250);
                    return false
                }
                if(!e.browser.msie) this.convertSPANs(false);
                e(this.container).show();
                e(this.textarea).show();
                e(this.iframe.contentWindow.document).mouseup(function(){
                    t.toolbar.checkState(t)
                });
                e(this.iframe.contentWindow.document).keyup(function(){
                    t.toolbar.checkState(t)
                });
                e(this.iframe.contentWindow.document).keydown(function(e){
                    t.detectPaste(e)
                });
                this.locked = false
            }, modifyFormSubmit  : function(){
                var t = this;
                var n = e(this.container).parents("form");
                n.submit(function(){
                    return t.updateuEditorInput()
                })
            }, insertNewParagraph: function(t, n){
                var r = e(this.iframe).contents().find("body");
                var i = this.iframe.contentWindow.document.createElement("p");
                e(t).each(function(){
                    e(i).append(this)
                });
                r.append(i)
            }, paragraphise      : function(){
                if(i.insertParagraphs && this.wysiwyg)
                {
                    var t = e(this.iframe).contents().find("body").contents();
                    t.each(function(){
                        if(this.nodeName.toLowerCase() == "#text" && this.data.search(/^\s*$/) != -1)
                        {
                            this.data = ""
                        }
                    });
                    var n = this;
                    var r = new Array;
                    t.each(function(){
                        if(e(this).is(":inline") || this.nodeType == 3)
                        {
                            r.push(this);
                            e(this).remove()
                        }
                        else if(e(this).is("br"))
                        {
                            if(!e(this).is(":last-child"))
                            {
                                if(e(this).next().is("br"))
                                {
                                    while(e(this).next().is("br"))
                                    {
                                        e(this).remove()
                                    }
                                    if(r.length)
                                    {
                                        n.insertNewParagraph(r, this);
                                        r = new Array
                                    }
                                }
                                else if(!e(this).is(":inline") && this.nodeType != 3)
                                {
                                    e(this).remove()
                                }
                                else if(r.length)
                                {
                                    r.push(this.cloneNode(true));
                                    e(this).remove()
                                }
                                else
                                {
                                    e(this).remove()
                                }
                            }
                        }
                        else if(r.length)
                        {
                            n.insertNewParagraph(r, this);
                            r = new Array
                        }
                    });
                    if(r.length > 0)
                    {
                        this.insertNewParagraph(r)
                    }
                }
            }, switchMode        : function(){
                if(!this.locked)
                {
                    this.locked = true;
                    if(this.wysiwyg)
                    {
                        this.updateuEditorInput();
                        e(this.textarea).val(e(this.input).val());
                        e(this.iframe).replaceWith(this.textarea);
                        this.toolbar.disable();
                        this.wysiwyg = false;
                        this.locked = false
                    }
                    else
                    {
                        this.updateuEditorInput();
                        e(this.textarea).replaceWith(this.iframe);
                        this.writeDocument(this.input.value);
                        this.toolbar.enable();
                        this.makeEditable();
                        this.wysiwyg = true
                    }
                }
            }, detectPaste       : function(e){
                if(!e.ctrlKey || e.keyCode != 86 || this.cleaning) return;
                var t = this;
                setTimeout(function(e){
                    t.cleanSource()
                }, 100)
            }, cleanSource       : function(){
                this.cleaning = true;
                var t = "";
                var n = e(this.iframe.contentWindow.document).find("body");
                if(!e.browser.msie) this.convertSPANs(true);
                e.each(i.undesiredTags, function(t, r){
                    n.find(t).each(function(){
                        switch(r)
                        {
                            case"remove":
                                e(this).remove();
                                break;
                            case"extractContent":
                                var t = e(this);
                                t.contents().each(function(){
                                    t.before(this)
                                });
                                t.remove();
                                break;
                            default:
                                e(this).remove();
                                break
                        }
                    })
                });
                if(this.wysiwyg) t = n.html();
                else t = e(this.textarea).val();
                t = t.replace(/^\s*/, "");
                t = t.replace(/\s*$/, "");
                t = t.replace(/<--.*-->/, "");
                t = t.replace(/<[^>]*>/g, function(t){
                    t = t.replace(/='(.*)' /g, '="$1" ');
                    t = t.replace(/ ([^=]+)="?([^"]*)"?/g, function(t, n, r){
                        if(e.inArray(n, i.allowedAttributes) == -1) return "";
                        switch(n)
                        {
                            case"id":
                                if(e.inArray(r, i.allowedIDs) == -1) return "";
                            case"class":
                                if(e.inArray(r, i.allowedClasses) == -1) return "";
                            default:
                                return t
                        }
                    });
                    return t.toLowerCase()
                });
                t = t.replace(/ style="[^"]*"/g, "");
                t = t.replace(/<br>/g, "<br />");
                t = t.replace(/<br \/>\s*<\/(h1|h2|h3|h4|h5|h6|li|p)/g, "</$1");
                t = t.replace(/(<br \/>)*\s*(<\/[^>]*>)/g, "$2$1");
                t = t.replace(/(<img [^>]+[^\/])>/g, "$1 />");
                t = t.replace(/(<[^\/]>|<[^\/][^>]*[^\/]>)\s*<\/[^>]*>/g, "");
                t = t.replace(/<\?xml[^>]*>/g, "");
                t = t.replace(/<[^ >]+:[^>]*>/g, "");
                t = t.replace(/<\/[^ >]+:[^>]*>/g, "");
                if(this.wysiwyg) e(this.iframe.contentWindow.document).find("body").html(t);
                else e(this.textarea).val(t);
                e(this.input).val(t);
                this.cleaning = false
            }, refreshDisplay    : function(){
                if(this.wysiwyg) e(this.iframe.contentWindow.document).find("body").html(e(this.input).val());
                else e(this.textarea).val(e(this.input).val())
            }, updateuEditorInput: function(){
                if(this.wysiwyg)
                {
                    this.paragraphise();
                    this.cleanSource()
                }
                else e(this.input).val(e(this.textarea).val())
            }, init              : function(e){
                if(typeof document.designMode != "string" && document.designMode != "off") return;
                this.locked = true;
                this.cleaning = false;
                this.DOMCache = "";
                this.wysiwyg = true;
                this.createDOM();
                this.writeDocument();
                this.makeEditable();
                this.modifyFormSubmit()
            }
        });
        this.init()
    };
    var o = function(t){
        e.extend(this, {
            createDOM    : function(){
                var t = this;
                this.itemsList = document.createElement("ul");
                e(this.itemsList).addClass("uEditorToolbar");
                e.each(this.uEditor.settings.toolbarItems, function(e, n){
                    if(n == "formatblock") t.addSelect(n);
                    else t.addButton(n)
                })
            }, addButton : function(t){
                var n = e.uEditorToolbarItems[t];
                var r = e(document.createElement("li"));
                var i = typeof this.uEditor.settings.translation[t] != "undefined"? this.uEditor.settings.translation[t] : n.label;
                var s = e(document.createElement("a")).attr({
                    title  : i,
                    "class": n.className,
                    href   : "javascript:void(0)"
                });
                n.editor = this.uEditor;
                e(s).data("action", n);
                e(s).data("editor", this.uEditor);
                s.bind("click", n.action);
                s.append(document.createTextNode(i));
                r.append(s);
                e(this.itemsList).append(r)
            }, addSelect : function(t){
                var n = this;
                var r = e.uEditorToolbarItems[t];
                var i = e(document.createElement("li")).attr("class", "uEditorEditSelect");
                var s = e(document.createElement("select")).attr({name: r.name, "class": r.className});
                e(s).data("editor", this.uEditor);
                e(s).change(r.action);
                var o = e(document.createElement("option"));
                var u = typeof this.uEditor.settings.translation[t] != "undefined"? this.uEditor.settings.translation[t] : r.label;
                o.append(document.createTextNode(u));
                s.append(o);
                e.each(this.uEditor.settings.selectBlockOptions, function(t, r){
                    var i = e(document.createElement("option")).attr("value", r);
                    i.append(document.createTextNode(n.uEditor.settings.translation[r]));
                    s.append(i)
                });
                i.append(s);
                e(this.itemsList).append(i)
            }, disable   : function(){
                e(this.itemsList).toggleClass("uEditorSource");
                e(this.itemsList).find("li select").attr("disabled", "disabled")
            }, enable    : function(){
                e(this.itemsList).toggleClass("uEditorSource");
                e(this.itemsList).find("select").removeAttr("disabled")
            }, checkState: function(t, n){
                if(!n)
                {
                    setTimeout(function(){
                        t.toolbar.checkState(t, true);
                        return true
                    }, 500);
                    return true
                }
                var r = null;
                var i = null;
                var s = null;
                e(t.toolbar.itemsList).find("a").removeClass("on");
                if(t.iframe.contentWindow.document.selection)
                {
                    r = t.iframe.contentWindow.document.selection;
                    i = r.createRange();
                    try
                    {
                        s = e(i.parentElement())
                    }
                    catch(o)
                    {
                        return false
                    }
                }
                else
                {
                    try
                    {
                        r = t.iframe.contentWindow.getSelection()
                    }
                    catch(o)
                    {
                        return false
                    }
                    i = r.getRangeAt(0);
                    s = e(i.commonAncestorContainer)
                }
                while(s.nodeType == 3)
                {
                    s = s.parent()
                }
                while(!s.is("body"))
                {
                    if(s.is("a")) t.toolbar.setState("link", "on");
                    else if(s.is("em")) t.toolbar.setState("italic", "on");
                    else if(s.is("strong")) t.toolbar.setState("bold", "on");
                    else if(s.is("span") || s.is("p"))
                    {
                        if(s.css("font-style") == "italic") t.toolbar.setState("italic", "on");
                        if(s.css("font-weight") == "bold") t.toolbar.setState("bold", "on")
                    }
                    else if(s.is("ol"))
                    {
                        t.toolbar.setState("orderedlist", "on");
                        t.toolbar.setState("unorderedlist", "off")
                    }
                    else if(s.is("ul"))
                    {
                        t.toolbar.setState("orderedlist", "on");
                        t.toolbar.setState("unorderedlist", "off")
                    }
                    else t.toolbar.setState("formatblock", s[0].nodeName.toLowerCase());
                    s = s.parent()
                }
            }, setState  : function(t, n){
                if(t != "SelectBlock") e(this.itemsList).find("." + e.uEditorToolbarItems[t].className).addClass("on");
                else e(this.itemsList).find("." + e.uEditorToolbarItems[t].className).val(n)
            }, init      : function(e){
                this.uEditor = e;
                this.createDOM()
            }
        });
        this.init(t)
    };
    var u = function(){
        r = this.constructor;
        if(typeof r.singleton != "undefined") return r.singleton;
        else r.singleton = this;
        e.extend(r.singleton, {
            bold            : {
                className: "uEditorButtonBold", action: function(){
                    var t = e.data(this, "editor");
                    if(!t.wysiwyg) return;
                    t.iframe.contentWindow.document.execCommand("bold", false, null);
                    t.toolbar.setState("bold", "on")
                }
            }, italic       : {
                className: "uEditorButtonItalic", action: function(){
                    var t = e.data(this, "editor");
                    if(!t.wysiwyg) return;
                    t.iframe.contentWindow.document.execCommand("italic", false, null);
                    t.toolbar.setState("italic", "on")
                }
            }, link         : {
                className: "uEditorButtonHyperlink", action: function(){
                    var t = e.data(this, "editor");
                    if(!t.wysiwyg) return;
                    if(e(this).hasClass("on"))
                    {
                        t.iframe.contentWindow.document.execCommand("Unlink", false, null);
                        return
                    }
                    var n = e(t.iframe).getSelection();
                    if(n == "")
                    {
                        alert(t.settings.translation.selectTextToHyperlink);
                        return
                    }
                    var r = prompt(t.settings.translation.linkURL, "http://");
                    if(r != null)
                    {
                        t.iframe.contentWindow.document.execCommand("CreateLink", false, r);
                        t.toolbar.setState("link", "on")
                    }
                }
            }, orderedlist  : {
                className: "uEditorButtonOrderedList", action: function(){
                    var t = e.data(this, "editor");
                    if(!t.wysiwyg) return;
                    t.iframe.contentWindow.document.execCommand("insertorderedlist", false, null);
                    t.toolbar.setState("orderedlist", "on")
                }
            }, unorderedlist: {
                className: "uEditorButtonUnorderedList", action: function(){
                    var t = e.data(this, "editor");
                    if(!t.wysiwyg) return;
                    t.iframe.contentWindow.document.execCommand("insertunorderedlist", false, null);
                    t.toolbar.setState("unorderedlist", "on")
                }
            }, image        : {
                className: "uEditorButtonImage", action: function(){
                    var t = e.data(this, "editor");
                    if(!t.wysiwyg) return;
                    var n = prompt(t.settings.translation.imageLocation, "");
                    if(n != null && n != "")
                    {
                        var r = prompt(t.settings.translation.imageAlternateText, "");
                        r = r.replace(/"/g, "'");
                        e(t.iframe).appendToSelection("img", {src: n, alt: r}, null, true)
                    }
                }
            }, htmlsource   : {
                className: "uEditorButtonHTML", action: function(){
                    var t = e.data(this, "editor");
                    t.switchMode()
                }
            }, formatblock  : {
                className: "uEditorSelectformatblock", action: function(){
                    var t = e.data(this, "editor");
                    if(!t.wysiwyg) return;
                    t.iframe.contentWindow.document.execCommand("formatblock", false, e(this).val())
                }
            }
        })
    };
    e.uEditorToolbarItems = new u;
    e.fn.extend({
        getSelection        : function(){
            if(!this.is("iframe")) return;
            else i = this[0];
            return i.contentWindow.document.selection? i.contentWindow.document.selection.createRange().text : i.contentWindow.getSelection().toString()
        }, appendToSelection: function(t, n, r, s){
            if(!this.is("iframe")) return;
            else i = this[0];
            var o, u;
            if(e.browser.msie)
            {
                var a;
                a = "<" + t;
                e.each(n, function(e, t){
                    a += " " + e + '="' + t + '"'
                });
                if(s) a += " />";
                else
                {
                    a += ">";
                    if(r && typeof r != "undefined") a += r;
                    a += "</" + t + ">"
                }
                o = i.contentWindow.document.selection;
                u = o.createRange();
                if(e(u.parentElement()).parents("body").is("#iframeBody ")) return;
                u.collapse(false);
                u.pasteHTML(a)
            }
            else
            {
                o = i.contentWindow.getSelection();
                u = o.getRangeAt(0);
                u.collapse(false);
                var f = i.contentWindow.document.createElement(t);
                e(f).attr(n);
                if(r && typeof r != "undefined") e(f).append(document.createTextNode(r));
                u.insertNode(f)
            }
        }, uEditor          : function(t){
            var n = {
                bold                 : "Bold",
                italic               : "Italic",
                link                 : "Hyperlink",
                unorderedlist        : "Unordered List",
                orderedlist          : "Ordered List",
                image                : "Insert image",
                htmlsource           : "HTML Source",
                formatblock          : "Change Block Type",
                h1                   : "Heading 1",
                h2                   : "Heading 2",
                h3                   : "Heading 3",
                h4                   : "Heading 4",
                h5                   : "Heading 5",
                h6                   : "Heading 6",
                p                    : "Paragraph",
                selectTextToHyperlink: "Please select the text you wish to hyperlink.",
                linkURL              : "Enter the URL for this link:",
                imageLocation        : "Enter the location for this image:",
                imageAlternateText   : "Enter the alternate text for this image:"
            };
            var r = {
                script  : "remove",
                meta    : "remove",
                link    : "remove",
                basefont: "remove",
                noscript: "extractContent",
                nobr    : "extractContent",
                object  : "remove",
                applet  : "remove",
                form    : "extractContent",
                fieldset: "extractContent",
                input   : "remove",
                select  : "remove",
                textarea: "remove",
                button  : "remove",
                isindex : "remove",
                label   : "extractContent",
                legend  : "extractContent",
                div     : "extractContent",
                table   : "extractContent",
                thead   : "extractContent",
                tbody   : "extractContent",
                tr      : "extractContent",
                td      : "extractContent",
                tfoot   : "extractContent",
                col     : "extractContent",
                colgroup: "extractContent",
                center  : "extractContent",
                area    : "remove",
                dir     : "extractContent",
                frame   : "remove",
                frameset: "remove",
                noframes: "remove",
                iframe  : "remove"
            };
            var i = ["class", "id", "href", "title", "alt", "src"];
            t = e.extend({
                insertParagraphs  : true,
                stylesheet        : "uEditorContent.css",
                toolbarItems      : ["bold", "italic", "link", "image", "orderedlist", "unorderedlist", "htmlsource", "formatblock"],
                selectBlockOptions: ["h1", "h2", "h3", "h4", "h5", "h6", "p"],
                undesiredTags     : r,
                allowedClasses    : new Array,
                allowedIDs        : new Array,
                allowedAttributes : i,
                containerClass    : "uEditor",
                translation       : n
            }, t);
            t.undesiredTags = t.undesiredTags.length != r.length? e.removeDuplicate(e.merge(t.undesiredTags, r)) : t.undesiredTags;
            t.allowedAttributes = t.allowedAttributes.length != i.length? e.removeDuplicate(e.merge(t.allowedAttributes, i)) : t.allowedAttributes;
            return this.each(function(){
                new s(this, t)
            })
        }
    })
})(jQuery)

/*
 CryptoJS v3.1.2
 code.google.com/p/crypto-js
 (c) 2009-2013 by Jeff Mott. All rights reserved.
 code.google.com/p/crypto-js/wiki/License
 */
var CryptoJS = CryptoJS || function(u, p){
    var d = {}, l = d.lib = {}, s = function(){
        }, t = l.Base = {
            extend: function(a){
                s.prototype = this;
                var c = new s;
                a && c.mixIn(a);
                c.hasOwnProperty("init") || (c.init = function(){
                    c.$super.init.apply(this, arguments)
                });
                c.init.prototype = c;
                c.$super = this;
                return c
            }, create: function(){
                var a = this.extend();
                a.init.apply(a, arguments);
                return a
            }, init: function(){
            }, mixIn: function(a){
                for(var c in a) a.hasOwnProperty(c) && (this[c] = a[c]);
                a.hasOwnProperty("toString") && (this.toString = a.toString)
            }, clone: function(){
                return this.init.prototype.extend(this)
            }
        },
        r = l.WordArray = t.extend({
            init: function(a, c){
                a = this.words = a || [];
                this.sigBytes = c != p? c : 4 * a.length
            }, toString: function(a){
                return (a || v).stringify(this)
            }, concat: function(a){
                var c = this.words, e = a.words, j = this.sigBytes;
                a = a.sigBytes;
                this.clamp();
                if(j % 4) for(var k = 0 ; k < a ; k++) c[j + k >>> 2] |= (e[k >>> 2] >>> 24 - 8 * (k % 4) & 255) << 24 - 8 * ((j + k) % 4);
                else if(65535 < e.length) for(k = 0 ; k < a ; k += 4) c[j + k >>> 2] = e[k >>> 2];
                else c.push.apply(c, e);
                this.sigBytes += a;
                return this
            }, clamp: function(){
                var a = this.words, c = this.sigBytes;
                a[c >>> 2] &= 4294967295 <<
                    32 - 8 * (c % 4);
                a.length = u.ceil(c / 4)
            }, clone   : function(){
                var a = t.clone.call(this);
                a.words = this.words.slice(0);
                return a
            }, random  : function(a){
                for(var c = [], e = 0 ; e < a ; e += 4) c.push(4294967296 * u.random() | 0);
                return new r.init(c, a)
            }
        }), w = d.enc = {}, v = w.Hex = {
            stringify: function(a){
                var c = a.words;
                a = a.sigBytes;
                for(var e = [], j = 0 ; j < a ; j++)
                {
                    var k = c[j >>> 2] >>> 24 - 8 * (j % 4) & 255;
                    e.push((k >>> 4).toString(16));
                    e.push((k & 15).toString(16))
                }
                return e.join("")
            }, parse: function(a){
                for(var c = a.length, e = [], j = 0 ; j < c ; j += 2) e[j >>> 3] |= parseInt(a.substr(j,
                    2), 16) << 24 - 4 * (j % 8);
                return new r.init(e, c / 2)
            }
        }, b = w.Latin1 = {
            stringify: function(a){
                var c = a.words;
                a = a.sigBytes;
                for(var e = [], j = 0 ; j < a ; j++) e.push(String.fromCharCode(c[j >>> 2] >>> 24 - 8 * (j % 4) & 255));
                return e.join("")
            }, parse: function(a){
                for(var c = a.length, e = [], j = 0 ; j < c ; j++) e[j >>> 2] |= (a.charCodeAt(j) & 255) << 24 - 8 * (j % 4);
                return new r.init(e, c)
            }
        }, x = w.Utf8 = {
            stringify: function(a){
                try
                {
                    return decodeURIComponent(escape(b.stringify(a)))
                }
                catch(c)
                {
                    throw Error("Malformed UTF-8 data");
                }
            }, parse: function(a){
                return b.parse(unescape(encodeURIComponent(a)))
            }
        },
        q = l.BufferedBlockAlgorithm = t.extend({
            reset            : function(){
                this._data = new r.init;
                this._nDataBytes = 0
            }, _append       : function(a){
                "string" == typeof a && (a = x.parse(a));
                this._data.concat(a);
                this._nDataBytes += a.sigBytes
            }, _process      : function(a){
                var c = this._data, e = c.words, j = c.sigBytes, k = this.blockSize, b = j / (4 * k),
                    b = a? u.ceil(b) : u.max((b | 0) - this._minBufferSize, 0);
                a = b * k;
                j = u.min(4 * a, j);
                if(a)
                {
                    for(var q = 0 ; q < a ; q += k) this._doProcessBlock(e, q);
                    q = e.splice(0, a);
                    c.sigBytes -= j
                }
                return new r.init(q, j)
            }, clone         : function(){
                var a = t.clone.call(this);
                a._data = this._data.clone();
                return a
            }, _minBufferSize: 0
        });
    l.Hasher = q.extend({
        cfg                 : t.extend(), init: function(a){
            this.cfg = this.cfg.extend(a);
            this.reset()
        }, reset            : function(){
            q.reset.call(this);
            this._doReset()
        }, update           : function(a){
            this._append(a);
            this._process();
            return this
        }, finalize         : function(a){
            a && this._append(a);
            return this._doFinalize()
        }, blockSize        : 16, _createHelper: function(a){
            return function(b, e){
                return (new a.init(e)).finalize(b)
            }
        }, _createHmacHelper: function(a){
            return function(b, e){
                return (new n.HMAC.init(a,
                    e)).finalize(b)
            }
        }
    });
    var n = d.algo = {};
    return d
}(Math);
(function(){
    var u = CryptoJS, p = u.lib.WordArray;
    u.enc.Base64 = {
        stringify: function(d){
            var l = d.words, p = d.sigBytes, t = this._map;
            d.clamp();
            d = [];
            for(var r = 0 ; r < p ; r += 3) for(var w = (l[r >>> 2] >>> 24 - 8 * (r % 4) & 255) << 16 | (l[r + 1 >>> 2] >>> 24 - 8 * ((r + 1) % 4) & 255) << 8 | l[r + 2 >>> 2] >>> 24 - 8 * ((r + 2) % 4) & 255, v = 0 ; 4 > v && r + 0.75 * v < p ; v++) d.push(t.charAt(w >>> 6 * (3 - v) & 63));
            if(l = t.charAt(64)) for(; d.length % 4 ;) d.push(l);
            return d.join("")
        }, parse : function(d){
            var l = d.length, s = this._map, t = s.charAt(64);
            t && (t = d.indexOf(t), -1 != t && (l = t));
            for(var t = [], r = 0, w = 0 ; w <
            l ; w++) if(w % 4)
            {
                var v = s.indexOf(d.charAt(w - 1)) << 2 * (w % 4), b = s.indexOf(d.charAt(w)) >>> 6 - 2 * (w % 4);
                t[r >>> 2] |= (v | b) << 24 - 8 * (r % 4);
                r++
            }
            return p.create(t, r)
        }, _map  : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    }
})();
(function(u){
    function p(b, n, a, c, e, j, k)
    {
        b = b + (n & a | ~n & c) + e + k;
        return (b << j | b >>> 32 - j) + n
    }

    function d(b, n, a, c, e, j, k)
    {
        b = b + (n & c | a & ~c) + e + k;
        return (b << j | b >>> 32 - j) + n
    }

    function l(b, n, a, c, e, j, k)
    {
        b = b + (n ^ a ^ c) + e + k;
        return (b << j | b >>> 32 - j) + n
    }

    function s(b, n, a, c, e, j, k)
    {
        b = b + (a ^ (n | ~c)) + e + k;
        return (b << j | b >>> 32 - j) + n
    }

    for(var t = CryptoJS, r = t.lib, w = r.WordArray, v = r.Hasher, r = t.algo, b = [], x = 0 ; 64 > x ; x++) b[x] = 4294967296 * u.abs(u.sin(x + 1)) | 0;
    r = r.MD5 = v.extend({
        _doReset       : function(){
            this._hash = new w.init([1732584193, 4023233417, 2562383102, 271733878])
        },
        _doProcessBlock: function(q, n){
            for(var a = 0 ; 16 > a ; a++)
            {
                var c = n + a, e = q[c];
                q[c] = (e << 8 | e >>> 24) & 16711935 | (e << 24 | e >>> 8) & 4278255360
            }
            var a = this._hash.words, c = q[n + 0], e = q[n + 1], j = q[n + 2], k = q[n + 3], z = q[n + 4],
                r = q[n + 5], t = q[n + 6], w = q[n + 7], v = q[n + 8], A = q[n + 9], B = q[n + 10], C = q[n + 11],
                u = q[n + 12], D = q[n + 13], E = q[n + 14], x = q[n + 15], f = a[0], m = a[1], g = a[2], h = a[3],
                f = p(f, m, g, h, c, 7, b[0]), h = p(h, f, m, g, e, 12, b[1]), g = p(g, h, f, m, j, 17, b[2]),
                m = p(m, g, h, f, k, 22, b[3]), f = p(f, m, g, h, z, 7, b[4]), h = p(h, f, m, g, r, 12, b[5]),
                g = p(g, h, f, m, t, 17, b[6]), m = p(m, g, h, f, w, 22, b[7]),
                f = p(f, m, g, h, v, 7, b[8]), h = p(h, f, m, g, A, 12, b[9]), g = p(g, h, f, m, B, 17, b[10]),
                m = p(m, g, h, f, C, 22, b[11]), f = p(f, m, g, h, u, 7, b[12]), h = p(h, f, m, g, D, 12, b[13]),
                g = p(g, h, f, m, E, 17, b[14]), m = p(m, g, h, f, x, 22, b[15]), f = d(f, m, g, h, e, 5, b[16]),
                h = d(h, f, m, g, t, 9, b[17]), g = d(g, h, f, m, C, 14, b[18]), m = d(m, g, h, f, c, 20, b[19]),
                f = d(f, m, g, h, r, 5, b[20]), h = d(h, f, m, g, B, 9, b[21]), g = d(g, h, f, m, x, 14, b[22]),
                m = d(m, g, h, f, z, 20, b[23]), f = d(f, m, g, h, A, 5, b[24]), h = d(h, f, m, g, E, 9, b[25]),
                g = d(g, h, f, m, k, 14, b[26]), m = d(m, g, h, f, v, 20, b[27]), f = d(f, m, g, h, D, 5, b[28]),
                h = d(h, f,
                    m, g, j, 9, b[29]), g = d(g, h, f, m, w, 14, b[30]), m = d(m, g, h, f, u, 20, b[31]),
                f = l(f, m, g, h, r, 4, b[32]), h = l(h, f, m, g, v, 11, b[33]), g = l(g, h, f, m, C, 16, b[34]),
                m = l(m, g, h, f, E, 23, b[35]), f = l(f, m, g, h, e, 4, b[36]), h = l(h, f, m, g, z, 11, b[37]),
                g = l(g, h, f, m, w, 16, b[38]), m = l(m, g, h, f, B, 23, b[39]), f = l(f, m, g, h, D, 4, b[40]),
                h = l(h, f, m, g, c, 11, b[41]), g = l(g, h, f, m, k, 16, b[42]), m = l(m, g, h, f, t, 23, b[43]),
                f = l(f, m, g, h, A, 4, b[44]), h = l(h, f, m, g, u, 11, b[45]), g = l(g, h, f, m, x, 16, b[46]),
                m = l(m, g, h, f, j, 23, b[47]), f = s(f, m, g, h, c, 6, b[48]), h = s(h, f, m, g, w, 10, b[49]),
                g = s(g, h, f, m,
                    E, 15, b[50]), m = s(m, g, h, f, r, 21, b[51]), f = s(f, m, g, h, u, 6, b[52]),
                h = s(h, f, m, g, k, 10, b[53]), g = s(g, h, f, m, B, 15, b[54]), m = s(m, g, h, f, e, 21, b[55]),
                f = s(f, m, g, h, v, 6, b[56]), h = s(h, f, m, g, x, 10, b[57]), g = s(g, h, f, m, t, 15, b[58]),
                m = s(m, g, h, f, D, 21, b[59]), f = s(f, m, g, h, z, 6, b[60]), h = s(h, f, m, g, C, 10, b[61]),
                g = s(g, h, f, m, j, 15, b[62]), m = s(m, g, h, f, A, 21, b[63]);
            a[0] = a[0] + f | 0;
            a[1] = a[1] + m | 0;
            a[2] = a[2] + g | 0;
            a[3] = a[3] + h | 0
        }, _doFinalize : function(){
            var b = this._data, n = b.words, a = 8 * this._nDataBytes, c = 8 * b.sigBytes;
            n[c >>> 5] |= 128 << 24 - c % 32;
            var e = u.floor(a /
                4294967296);
            n[(c + 64 >>> 9 << 4) + 15] = (e << 8 | e >>> 24) & 16711935 | (e << 24 | e >>> 8) & 4278255360;
            n[(c + 64 >>> 9 << 4) + 14] = (a << 8 | a >>> 24) & 16711935 | (a << 24 | a >>> 8) & 4278255360;
            b.sigBytes = 4 * (n.length + 1);
            this._process();
            b = this._hash;
            n = b.words;
            for(a = 0 ; 4 > a ; a++) c = n[a], n[a] = (c << 8 | c >>> 24) & 16711935 | (c << 24 | c >>> 8) & 4278255360;
            return b
        }, clone       : function(){
            var b = v.clone.call(this);
            b._hash = this._hash.clone();
            return b
        }
    });
    t.MD5 = v._createHelper(r);
    t.HmacMD5 = v._createHmacHelper(r)
})(Math);
(function(){
    var u = CryptoJS, p = u.lib, d = p.Base, l = p.WordArray, p = u.algo, s = p.EvpKDF = d.extend({
        cfg       : d.extend({keySize: 4, hasher: p.MD5, iterations: 1}), init: function(d){
            this.cfg = this.cfg.extend(d)
        }, compute: function(d, r){
            for(var p = this.cfg, s = p.hasher.create(), b = l.create(), u = b.words, q = p.keySize, p = p.iterations ; u.length < q ;)
            {
                n && s.update(n);
                var n = s.update(d).finalize(r);
                s.reset();
                for(var a = 1 ; a < p ; a++) n = s.finalize(n), s.reset();
                b.concat(n)
            }
            b.sigBytes = 4 * q;
            return b
        }
    });
    u.EvpKDF = function(d, l, p){
        return s.create(p).compute(d,
            l)
    }
})();
CryptoJS.lib.Cipher || function(u){
    var p = CryptoJS, d = p.lib, l = d.Base, s = d.WordArray, t = d.BufferedBlockAlgorithm, r = p.enc.Base64,
        w = p.algo.EvpKDF, v = d.Cipher = t.extend({
            cfg                                                                            : l.extend(), createEncryptor                                               : function(e, a){
                return this.create(this._ENC_XFORM_MODE, e, a)
            }, createDecryptor                                                             : function(e, a){
                return this.create(this._DEC_XFORM_MODE, e, a)
            }, init                                                                        : function(e, a, b){
                this.cfg = this.cfg.extend(b);
                this._xformMode = e;
                this._key = a;
                this.reset()
            }, reset                                                                       : function(){
                t.reset.call(this);
                this._doReset()
            }, process                                                                     : function(e){
                this._append(e);
                return this._process()
            },
            finalize: function(e){
                e && this._append(e);
                return this._doFinalize()
            }, keySize: 4, ivSize: 4, _ENC_XFORM_MODE: 1, _DEC_XFORM_MODE: 2, _createHelper: function(e){
                return {
                    encrypt: function(b, k, d){
                        return ("string" == typeof k? c : a).encrypt(e, b, k, d)
                    }, decrypt: function(b, k, d){
                        return ("string" == typeof k? c : a).decrypt(e, b, k, d)
                    }
                }
            }
        });
    d.StreamCipher = v.extend({
        _doFinalize : function(){
            return this._process(!0)
        }, blockSize: 1
    });
    var b = p.mode = {}, x = function(e, a, b){
        var c = this._iv;
        c? this._iv = u : c = this._prevBlock;
        for(var d = 0 ; d < b ; d++) e[a + d] ^=
            c[d]
    }, q = (d.BlockCipherMode = l.extend({
        createEncryptor   : function(e, a){
            return this.Encryptor.create(e, a)
        }, createDecryptor: function(e, a){
            return this.Decryptor.create(e, a)
        }, init           : function(e, a){
            this._cipher = e;
            this._iv = a
        }
    })).extend();
    q.Encryptor = q.extend({
        processBlock: function(e, a){
            var b = this._cipher, c = b.blockSize;
            x.call(this, e, a, c);
            b.encryptBlock(e, a);
            this._prevBlock = e.slice(a, a + c)
        }
    });
    q.Decryptor = q.extend({
        processBlock: function(e, a){
            var b = this._cipher, c = b.blockSize, d = e.slice(a, a + c);
            b.decryptBlock(e, a);
            x.call(this,
                e, a, c);
            this._prevBlock = d
        }
    });
    b = b.CBC = q;
    q = (p.pad = {}).Pkcs7 = {
        pad     : function(a, b){
            for(var c = 4 * b, c = c - a.sigBytes % c, d = c << 24 | c << 16 | c << 8 | c, l = [], n = 0 ; n < c ; n += 4) l.push(d);
            c = s.create(l, c);
            a.concat(c)
        }, unpad: function(a){
            a.sigBytes -= a.words[a.sigBytes - 1 >>> 2] & 255
        }
    };
    d.BlockCipher = v.extend({
        cfg               : v.cfg.extend({mode: b, padding: q}), reset: function(){
            v.reset.call(this);
            var a = this.cfg, b = a.iv, a = a.mode;
            if(this._xformMode == this._ENC_XFORM_MODE) var c = a.createEncryptor;
            else c = a.createDecryptor, this._minBufferSize = 1;
            this._mode = c.call(a,
                this, b && b.words)
        }, _doProcessBlock: function(a, b){
            this._mode.processBlock(a, b)
        }, _doFinalize    : function(){
            var a = this.cfg.padding;
            if(this._xformMode == this._ENC_XFORM_MODE)
            {
                a.pad(this._data, this.blockSize);
                var b = this._process(!0)
            }
            else b = this._process(!0), a.unpad(b);
            return b
        }, blockSize      : 4
    });
    var n = d.CipherParams = l.extend({
        init       : function(a){
            this.mixIn(a)
        }, toString: function(a){
            return (a || this.formatter).stringify(this)
        }
    }), b = (p.format = {}).OpenSSL = {
        stringify: function(a){
            var b = a.ciphertext;
            a = a.salt;
            return (a? s.create([1398893684,
                1701076831]).concat(a).concat(b) : b).toString(r)
        }, parse : function(a){
            a = r.parse(a);
            var b = a.words;
            if(1398893684 == b[0] && 1701076831 == b[1])
            {
                var c = s.create(b.slice(2, 4));
                b.splice(0, 4);
                a.sigBytes -= 16
            }
            return n.create({ciphertext: a, salt: c})
        }
    }, a = d.SerializableCipher = l.extend({
        cfg      : l.extend({format: b}), encrypt: function(a, b, c, d){
            d = this.cfg.extend(d);
            var l = a.createEncryptor(c, d);
            b = l.finalize(b);
            l = l.cfg;
            return n.create({
                ciphertext: b,
                key       : c,
                iv        : l.iv,
                algorithm : a,
                mode      : l.mode,
                padding   : l.padding,
                blockSize : a.blockSize,
                formatter : d.format
            })
        },
        decrypt  : function(a, b, c, d){
            d = this.cfg.extend(d);
            b = this._parse(b, d.format);
            return a.createDecryptor(c, d).finalize(b.ciphertext)
        }, _parse: function(a, b){
            return "string" == typeof a? b.parse(a, this) : a
        }
    }), p = (p.kdf = {}).OpenSSL = {
        execute: function(a, b, c, d){
            d || (d = s.random(8));
            a = w.create({keySize: b + c}).compute(a, d);
            c = s.create(a.words.slice(b), 4 * c);
            a.sigBytes = 4 * b;
            return n.create({key: a, iv: c, salt: d})
        }
    }, c = d.PasswordBasedCipher = a.extend({
        cfg       : a.cfg.extend({kdf: p}), encrypt: function(b, c, d, l){
            l = this.cfg.extend(l);
            d = l.kdf.execute(d,
                b.keySize, b.ivSize);
            l.iv = d.iv;
            b = a.encrypt.call(this, b, c, d.key, l);
            b.mixIn(d);
            return b
        }, decrypt: function(b, c, d, l){
            l = this.cfg.extend(l);
            c = this._parse(c, l.format);
            d = l.kdf.execute(d, b.keySize, b.ivSize, c.salt);
            l.iv = d.iv;
            return a.decrypt.call(this, b, c, d.key, l)
        }
    })
}();
(function(){
    for(var u = CryptoJS, p = u.lib.BlockCipher, d = u.algo, l = [], s = [], t = [], r = [], w = [], v = [], b = [], x = [], q = [], n = [], a = [], c = 0 ; 256 > c ; c++) a[c] = 128 > c? c << 1 : c << 1 ^ 283;
    for(var e = 0, j = 0, c = 0 ; 256 > c ; c++)
    {
        var k = j ^ j << 1 ^ j << 2 ^ j << 3 ^ j << 4, k = k >>> 8 ^ k & 255 ^ 99;
        l[e] = k;
        s[k] = e;
        var z = a[e], F = a[z], G = a[F], y = 257 * a[k] ^ 16843008 * k;
        t[e] = y << 24 | y >>> 8;
        r[e] = y << 16 | y >>> 16;
        w[e] = y << 8 | y >>> 24;
        v[e] = y;
        y = 16843009 * G ^ 65537 * F ^ 257 * z ^ 16843008 * e;
        b[k] = y << 24 | y >>> 8;
        x[k] = y << 16 | y >>> 16;
        q[k] = y << 8 | y >>> 24;
        n[k] = y;
        e? (e = z ^ a[a[a[G ^ z]]], j ^= a[a[j]]) : e = j = 1
    }
    var H = [0, 1, 2, 4, 8,
        16, 32, 64, 128, 27, 54], d = d.AES = p.extend({
        _doReset        : function(){
            for(var a = this._key, c = a.words, d = a.sigBytes / 4, a = 4 * ((this._nRounds = d + 6) + 1), e = this._keySchedule = [], j = 0 ; j < a ; j++) if(j < d) e[j] = c[j];
            else
            {
                var k = e[j - 1];
                j % d? 6 < d && 4 == j % d && (k = l[k >>> 24] << 24 | l[k >>> 16 & 255] << 16 | l[k >>> 8 & 255] << 8 | l[k & 255]) : (k = k << 8 | k >>> 24, k = l[k >>> 24] << 24 | l[k >>> 16 & 255] << 16 | l[k >>> 8 & 255] << 8 | l[k & 255], k ^= H[j / d | 0] << 24);
                e[j] = e[j - d] ^ k
            }
            c = this._invKeySchedule = [];
            for(d = 0 ; d < a ; d++) j = a - d, k = d % 4? e[j] : e[j - 4], c[d] = 4 > d || 4 >= j? k : b[l[k >>> 24]] ^ x[l[k >>> 16 & 255]] ^ q[l[k >>>
            8 & 255]] ^ n[l[k & 255]]
        }, encryptBlock : function(a, b){
            this._doCryptBlock(a, b, this._keySchedule, t, r, w, v, l)
        }, decryptBlock : function(a, c){
            var d = a[c + 1];
            a[c + 1] = a[c + 3];
            a[c + 3] = d;
            this._doCryptBlock(a, c, this._invKeySchedule, b, x, q, n, s);
            d = a[c + 1];
            a[c + 1] = a[c + 3];
            a[c + 3] = d
        }, _doCryptBlock: function(a, b, c, d, e, j, l, f){
            for(var m = this._nRounds, g = a[b] ^ c[0], h = a[b + 1] ^ c[1], k = a[b + 2] ^ c[2], n = a[b + 3] ^ c[3], p = 4, r = 1 ; r < m ; r++) var q = d[g >>> 24] ^ e[h >>> 16 & 255] ^ j[k >>> 8 & 255] ^ l[n & 255] ^ c[p++], s = d[h >>> 24] ^ e[k >>> 16 & 255] ^ j[n >>> 8 & 255] ^ l[g & 255] ^ c[p++], t =
                d[k >>> 24] ^ e[n >>> 16 & 255] ^ j[g >>> 8 & 255] ^ l[h & 255] ^ c[p++], n = d[n >>> 24] ^ e[g >>> 16 & 255] ^ j[h >>> 8 & 255] ^ l[k & 255] ^ c[p++], g = q, h = s, k = t;
            q = (f[g >>> 24] << 24 | f[h >>> 16 & 255] << 16 | f[k >>> 8 & 255] << 8 | f[n & 255]) ^ c[p++];
            s = (f[h >>> 24] << 24 | f[k >>> 16 & 255] << 16 | f[n >>> 8 & 255] << 8 | f[g & 255]) ^ c[p++];
            t = (f[k >>> 24] << 24 | f[n >>> 16 & 255] << 16 | f[g >>> 8 & 255] << 8 | f[h & 255]) ^ c[p++];
            n = (f[n >>> 24] << 24 | f[g >>> 16 & 255] << 16 | f[h >>> 8 & 255] << 8 | f[k & 255]) ^ c[p++];
            a[b] = q;
            a[b + 1] = s;
            a[b + 2] = t;
            a[b + 3] = n
        }, keySize      : 8
    });
    u.AES = p._createHelper(d)
})();

function l(path, obj)
{
    if(obj)
        return;
    if(path.indexOf('.js') > -1)
    {
        var s = document.createElement('script');
        s.type = "text/javascript";
        s.src = path;
        document.getElementsByTagName('head')[0].appendChild(s);
    }
    else if(path.indexOf('.css') > -1)
    {
        var s = document.createElement('link');
        s.type = "text/css";
        s.rel = "stylesheet";
        s.href = path;
        document.getElementsByTagName('head')[0].appendChild(s);
    }
}

function l2(s)
{
    var o = new XMLHttpRequest();
// open and send a synchronous request
    o.open('GET', s, false);
//    o.setRequestHeader('Access-Control-Allow-Origin', '*');
//    o.setRequestHeader('Access-Control-Allow-Headers','Content-Type');
//    o.setRequestHeader('Access-Control-Allow-Methods','GET, PUT, POST, DELETE, OPTIONS');
//    o.onreadystatechange = proccessXML;

    o.send(null);
// add the returned content to a newly created script tag
    var s = document.createElement('script');
    s.type = "text/javascript";
    s.text = o.responseText;
    document.getElementsByTagName('head')[0].appendChild(s);
}

var McxLib =
        {
            THREE: function(){
                if(!window['THREE'])
                {
                    l2("etc/lib/Three/three.js");
                    l2("etc/lib/Three/OrbitControls.js");
                    l2("etc/lib/Three/OBJLoader.js");
//            l("http://rawgithub.com/mrdoob/three.js/master/examples/js/controls/FirstPersonControls.js");

                    THREE.Utils = {
                        cameraLookDir: function(camera){
                            var vector = new THREE.Vector3(0, 0, -1);
                            vector.applyEuler(camera.rotation, camera.eulerOrder);
                            return vector;
                        }
                    };
                    THREE.PerspectiveCamera.prototype.setRotateX = function(deg){
                        if(typeof(deg) == 'number' && parseInt(deg) == deg)
                        {
                            this.rotation.x = deg * (Math.PI / 180);
                        }
                    };
                    THREE.PerspectiveCamera.prototype.setRotateY = function(deg){
                        if(typeof(deg) == 'number' && parseInt(deg) == deg)
                        {
                            this.rotation.y = deg * (Math.PI / 180);
                        }
                    };
                    THREE.PerspectiveCamera.prototype.setRotateZ = function(deg){
                        if(typeof(deg) == 'number' && parseInt(deg) == deg)
                        {
                            this.rotation.z = deg * (Math.PI / 180);
                        }
                    };
                    THREE.PerspectiveCamera.prototype.getRotateX = function(){
                        return Math.round(this.rotation.x * (180 / Math.PI));
                    };
                    THREE.PerspectiveCamera.prototype.getRotateY = function(){
                        return Math.round(this.rotation.y * (180 / Math.PI));
                    };
                    THREE.PerspectiveCamera.prototype.getRotateZ = function(){
                        return Math.round(this.rotation.z * (180 / Math.PI));
                    };

                }
                return THREE;
            },
            proj4: function(){
                return proj4;
            }
        }



//print
;(function(g){
    function k(c)
    {
        c && c.printPage? c.printPage() : setTimeout(function(){
            k(c)
        }, 50)
    }

    function l(c)
    {
        c = a(c);
        a(":checked", c).each(function(){
            this.setAttribute("checked", "checked")
        });
        a("input[type='text']", c).each(function(){
            this.setAttribute("value", a(this).val())
        });
        a("select", c).each(function(){
            var b = a(this);
            a("option", b).each(function(){
                b.val() == a(this).val() && this.setAttribute("selected", "selected")
            })
        });
        a("textarea", c).each(function(){
            var b = a(this).attr("value");
            if(a.browser.b && this.firstChild) this.firstChild.textContent =
                b;
            else this.innerHTML = b
        });
        return a("<div></div>").append(c.clone()).html()
    }

    function m(c, b)
    {
        var i = a(c);
        c = l(c);
        var d = [];
        d.push("<html><head><title>" + b.pageTitle + "</title>");
        if(b.overrideElementCSS)
        {
            if(b.overrideElementCSS.length > 0) for(var f = 0 ; f < b.overrideElementCSS.length ; f++)
            {
                var e = b.overrideElementCSS[f];
                typeof e == "string"? d.push('<link type="text/css" rel="stylesheet" href="' + e + '" >') : d.push('<link type="text/css" rel="stylesheet" href="' + e.href + '" media="' + e.media + '" >')
            }
        }
        else a("link", j).filter(function(){
            return a(this).attr("rel").toLowerCase() ==
                "stylesheet"
        }).each(function(){
            d.push('<link type="text/css" rel="stylesheet" href="' + a(this).attr("href") + '" media="' + a(this).attr("media") + '" >')
        });
        d.push('<base href="' + (g.location.protocol + "//" + g.location.hostname + (g.location.port? ":" + g.location.port : "") + g.location.pathname) + '" />');
        d.push('</head><body style="' + b.printBodyOptions.styleToAdd + '" class="' + b.printBodyOptions.classNameToAdd + '">');
        d.push('<div class="' + i.attr("class") + '">' + c + "</div>");
        d.push('<script type="text/javascript">function printPage(){focus();print();' +
            (!a.browser.opera && !b.leaveOpen && b.printMode.toLowerCase() == "popup"? "close();" : "") + "}<\/script>");
        d.push("</body></html>");
        return d.join("")
    }

    var j = g.document, a = g.jQuery;
    a.fn.printElement = function(c){
        var b = a.extend({}, a.fn.printElement.defaults, c);
        if(b.printMode == "iframe") if(a.browser.opera || /chrome/.test(navigator.userAgent.toLowerCase())) b.printMode = "popup";
        a("[id^='printElement_']").remove();
        return this.each(function(){
            var i = a.a? a.extend({}, b, a(this).data()) : b, d = a(this);
            d = m(d, i);
            var f = null, e = null;
            if(i.printMode.toLowerCase() == "popup")
            {
                f = g.open("about:blank", "printElementWindow", "width=650,height=440,scrollbars=yes");
                e = f.document
            }
            else
            {
                f = "printElement_" + Math.round(Math.random() * 99999).toString();
                var h = j.createElement("IFRAME");
                a(h).attr({
                    style      : i.iframeElementOptions.styleToAdd,
                    id         : f,
                    className  : i.iframeElementOptions.classNameToAdd,
                    frameBorder: 0,
                    scrolling  : "no",
                    src        : "about:blank"
                });
                j.body.appendChild(h);
                e = h.contentWindow || h.contentDocument;
                if(e.document) e = e.document;
                h = j.frames? j.frames[f] : j.getElementById(f);
                f = h.contentWindow || h
            }
            e.open();
            e.write(d);
            e.close();
            k(f)
        })
    };
    a.fn.printElement.defaults = {
        printMode           : "iframe",
        pageTitle           : "",
        overrideElementCSS  : null,
        printBodyOptions    : {styleToAdd: "padding:10px;margin:10px;", classNameToAdd: ""},
        leaveOpen           : false,
        iframeElementOptions: {
            styleToAdd    : "border:none;position:absolute;width:0px;height:0px;bottom:0px;left:0px;",
            classNameToAdd: ""
        }
    };
    a.fn.printElement.cssElement = {href: "", media: ""}
})(window);

(function(window, document, undefined){
    var _html2canvas = {}, previousElement, computedCSS, html2canvas;
    _html2canvas.Util = {};
    _html2canvas.Util.log = function(a){
        if(_html2canvas.logging && window.console && window.console.log)
        {
            window.console.log(a)
        }
    };
    _html2canvas.Util.trimText = (function(isNative){
        return function(input){
            return isNative? isNative.apply(input) : ((input || "") + "").replace(/^\s+|\s+$/g, "")
        }
    })(String.prototype.trim);
    _html2canvas.Util.asFloat = function(v){
        return parseFloat(v)
    };
    (function(){
        var TEXT_SHADOW_PROPERTY = /((rgba|rgb)\([^\)]+\)(\s-?\d+px){0,})/g;
        var TEXT_SHADOW_VALUES = /(-?\d+px)|(#.+)|(rgb\(.+\))|(rgba\(.+\))/g;
        _html2canvas.Util.parseTextShadows = function(value){
            if(!value || value === "none")
            {
                return []
            }
            var shadows = value.match(TEXT_SHADOW_PROPERTY), results = [];
            for(var i = 0 ; shadows && (i < shadows.length) ; i++)
            {
                var s = shadows[i].match(TEXT_SHADOW_VALUES);
                results.push({
                    color  : s[0],
                    offsetX: s[1]? s[1].replace("px", "") : 0,
                    offsetY: s[2]? s[2].replace("px", "") : 0,
                    blur   : s[3]? s[3].replace("px", "") : 0
                })
            }
            return results
        }
    })();
    _html2canvas.Util.parseBackgroundImage = function(value){
        var whitespace = " \r\n\t", method, definition, prefix, prefix_i, block, results = [], c, mode = 0,
            numParen = 0, quote, args;
        var appendResult = function(){
            if(method)
            {
                if(definition.substr(0, 1) === '"')
                {
                    definition = definition.substr(1, definition.length - 2)
                }
                if(definition)
                {
                    args.push(definition)
                }
                if(method.substr(0, 1) === "-" && (prefix_i = method.indexOf("-", 1) + 1) > 0)
                {
                    prefix = method.substr(0, prefix_i);
                    method = method.substr(prefix_i)
                }
                results.push({prefix: prefix, method: method.toLowerCase(), value: block, args: args})
            }
            args = [];
            method = prefix = definition = block = ""
        };
        appendResult();
        for(var i = 0, ii = value.length ; i < ii ; i++)
        {
            c = value[i];
            if(mode === 0 && whitespace.indexOf(c) > -1)
            {
                continue
            }
            switch(c)
            {
                case'"':
                    if(!quote)
                    {
                        quote = c
                    }
                    else
                    {
                        if(quote === c)
                        {
                            quote = null
                        }
                    }
                    break;
                case"(":
                    if(quote)
                    {
                        break
                    }
                    else
                    {
                        if(mode === 0)
                        {
                            mode = 1;
                            block += c;
                            continue
                        }
                        else
                        {
                            numParen++
                        }
                    }
                    break;
                case")":
                    if(quote)
                    {
                        break
                    }
                    else
                    {
                        if(mode === 1)
                        {
                            if(numParen === 0)
                            {
                                mode = 0;
                                block += c;
                                appendResult();
                                continue
                            }
                            else
                            {
                                numParen--
                            }
                        }
                    }
                    break;
                case",":
                    if(quote)
                    {
                        break
                    }
                    else
                    {
                        if(mode === 0)
                        {
                            appendResult();
                            continue
                        }
                        else
                        {
                            if(mode === 1)
                            {
                                if(numParen === 0 && !method.match(/^url$/i))
                                {
                                    args.push(definition);
                                    definition = "";
                                    block += c;
                                    continue
                                }
                            }
                        }
                    }
                    break
            }
            block += c;
            if(mode === 0)
            {
                method += c
            }
            else
            {
                definition += c
            }
        }
        appendResult();
        return results
    };
    _html2canvas.Util.Bounds = function(element){
        var clientRect, bounds = {};
        if(element.getBoundingClientRect)
        {
            clientRect = element.getBoundingClientRect();
            bounds.top = clientRect.top;
            bounds.bottom = clientRect.bottom || (clientRect.top + clientRect.height);
            bounds.left = clientRect.left;
            bounds.width = element.offsetWidth;
            bounds.height = element.offsetHeight
        }
        return bounds
    };
    _html2canvas.Util.OffsetBounds = function(element){
        var parent = element.offsetParent? _html2canvas.Util.OffsetBounds(element.offsetParent) : {top: 0, left: 0};
        return {
            top   : element.offsetTop + parent.top,
            bottom: element.offsetTop + element.offsetHeight + parent.top,
            left  : element.offsetLeft + parent.left,
            width : element.offsetWidth,
            height: element.offsetHeight
        }
    };

    function toPX(element, attribute, value)
    {
        var rsLeft = element.runtimeStyle && element.runtimeStyle[attribute], left, style = element.style;
        if(!/^-?[0-9]+\.?[0-9]*(?:px)?$/i.test(value) && /^-?\d/.test(value))
        {
            left = style.left;
            if(rsLeft)
            {
                element.runtimeStyle.left = element.currentStyle.left
            }
            style.left = attribute === "fontSize"? "1em" : (value || 0);
            value = style.pixelLeft + "px";
            style.left = left;
            if(rsLeft)
            {
                element.runtimeStyle.left = rsLeft
            }
        }
        if(!/^(thin|medium|thick)$/i.test(value))
        {
            return Math.round(parseFloat(value)) + "px"
        }
        return value
    }

    function asInt(val)
    {
        return parseInt(val, 10)
    }

    function parseBackgroundSizePosition(value, element, attribute, index)
    {
        value = (value || "").split(",");
        value = value[index || 0] || value[0] || "auto";
        value = _html2canvas.Util.trimText(value).split(" ");
        if(attribute === "backgroundSize" && (!value[0] || value[0].match(/cover|contain|auto/)))
        {
        }
        else
        {
            value[0] = (value[0].indexOf("%") === -1)? toPX(element, attribute + "X", value[0]) : value[0];
            if(value[1] === undefined)
            {
                if(attribute === "backgroundSize")
                {
                    value[1] = "auto";
                    return value
                }
                else
                {
                    value[1] = value[0]
                }
            }
            value[1] = (value[1].indexOf("%") === -1)? toPX(element, attribute + "Y", value[1]) : value[1]
        }
        return value
    }

    _html2canvas.Util.getCSS = function(element, attribute, index){
        if(previousElement !== element)
        {
            computedCSS = document.defaultView.getComputedStyle(element, null)
        }
        var value = computedCSS[attribute];
        if(/^background(Size|Position)$/.test(attribute))
        {
            return parseBackgroundSizePosition(value, element, attribute, index)
        }
        else
        {
            if(/border(Top|Bottom)(Left|Right)Radius/.test(attribute))
            {
                var arr = value.split(" ");
                if(arr.length <= 1)
                {
                    arr[1] = arr[0]
                }
                return arr.map(asInt)
            }
        }
        return value
    };
    _html2canvas.Util.resizeBounds = function(current_width, current_height, target_width, target_height, stretch_mode){
        var target_ratio = target_width / target_height, current_ratio = current_width / current_height, output_width,
            output_height;
        if(!stretch_mode || stretch_mode === "auto")
        {
            output_width = target_width;
            output_height = target_height
        }
        else
        {
            if(target_ratio < current_ratio ^ stretch_mode === "contain")
            {
                output_height = target_height;
                output_width = target_height * current_ratio
            }
            else
            {
                output_width = target_width;
                output_height = target_width / current_ratio
            }
        }
        return {width: output_width, height: output_height}
    };

    function backgroundBoundsFactory(prop, el, bounds, image, imageIndex, backgroundSize)
    {
        var bgposition = _html2canvas.Util.getCSS(el, prop, imageIndex), topPos, left, percentage, val;
        if(bgposition.length === 1)
        {
            val = bgposition[0];
            bgposition = [];
            bgposition[0] = val;
            bgposition[1] = val
        }
        if(bgposition[0].toString().indexOf("%") !== -1)
        {
            percentage = (parseFloat(bgposition[0]) / 100);
            left = bounds.width * percentage;
            if(prop !== "backgroundSize")
            {
                left -= (backgroundSize || image).width * percentage
            }
        }
        else
        {
            if(prop === "backgroundSize")
            {
                if(bgposition[0] === "auto")
                {
                    left = image.width
                }
                else
                {
                    if(/contain|cover/.test(bgposition[0]))
                    {
                        var resized = _html2canvas.Util.resizeBounds(image.width, image.height, bounds.width, bounds.height, bgposition[0]);
                        left = resized.width;
                        topPos = resized.height
                    }
                    else
                    {
                        left = parseInt(bgposition[0], 10)
                    }
                }
            }
            else
            {
                left = parseInt(bgposition[0], 10)
            }
        }
        if(bgposition[1] === "auto")
        {
            topPos = left / image.width * image.height
        }
        else
        {
            if(bgposition[1].toString().indexOf("%") !== -1)
            {
                percentage = (parseFloat(bgposition[1]) / 100);
                topPos = bounds.height * percentage;
                if(prop !== "backgroundSize")
                {
                    topPos -= (backgroundSize || image).height * percentage
                }
            }
            else
            {
                topPos = parseInt(bgposition[1], 10)
            }
        }
        return [left, topPos]
    }

    _html2canvas.Util.BackgroundPosition = function(el, bounds, image, imageIndex, backgroundSize){
        var result = backgroundBoundsFactory("backgroundPosition", el, bounds, image, imageIndex, backgroundSize);
        return {left: result[0], top: result[1]}
    };
    _html2canvas.Util.BackgroundSize = function(el, bounds, image, imageIndex){
        var result = backgroundBoundsFactory("backgroundSize", el, bounds, image, imageIndex);
        return {width: result[0], height: result[1]}
    };
    _html2canvas.Util.Extend = function(options, defaults){
        for(var key in options)
        {
            if(options.hasOwnProperty(key))
            {
                defaults[key] = options[key]
            }
        }
        return defaults
    };
    _html2canvas.Util.Children = function(elem){
        var children;
        try
        {
            children = (elem.nodeName && elem.nodeName.toUpperCase() === "IFRAME")? elem.contentDocument || elem.contentWindow.document : (function(array){
                var ret = [];
                if(array !== null)
                {
                    (function(first, second){
                        var i = first.length, j = 0;
                        if(typeof second.length === "number")
                        {
                            for(var l = second.length ; j < l ; j++)
                            {
                                first[i++] = second[j]
                            }
                        }
                        else
                        {
                            while(second[j] !== undefined)
                            {
                                first[i++] = second[j++]
                            }
                        }
                        first.length = i;
                        return first
                    })(ret, array)
                }
                return ret
            })(elem.childNodes)
        }
        catch(ex)
        {
            _html2canvas.Util.log("html2canvas.Util.Children failed with exception: " + ex.message);
            children = []
        }
        return children
    };
    _html2canvas.Util.isTransparent = function(backgroundColor){
        return (backgroundColor === "transparent" || backgroundColor === "rgba(0, 0, 0, 0)")
    };
    _html2canvas.Util.Font = (function(){
        var fontData = {};
        return function(font, fontSize, doc){
            if(fontData[font + "-" + fontSize] !== undefined)
            {
                return fontData[font + "-" + fontSize]
            }
            var container = doc.createElement("div"), img = doc.createElement("img"), span = doc.createElement("span"),
                sampleText = "Hidden Text", baseline, middle, metricsObj;
            container.style.visibility = "hidden";
            container.style.fontFamily = font;
            container.style.fontSize = fontSize;
            container.style.margin = 0;
            container.style.padding = 0;
            doc.body.appendChild(container);
            img.src = "data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";
            img.width = 1;
            img.height = 1;
            img.style.margin = 0;
            img.style.padding = 0;
            img.style.verticalAlign = "baseline";
            span.style.fontFamily = font;
            span.style.fontSize = fontSize;
            span.style.margin = 0;
            span.style.padding = 0;
            span.appendChild(doc.createTextNode(sampleText));
            container.appendChild(span);
            container.appendChild(img);
            baseline = (img.offsetTop - span.offsetTop) + 1;
            container.removeChild(span);
            container.appendChild(doc.createTextNode(sampleText));
            container.style.lineHeight = "normal";
            img.style.verticalAlign = "super";
            middle = (img.offsetTop - container.offsetTop) + 1;
            metricsObj = {baseline: baseline, lineWidth: 1, middle: middle};
            fontData[font + "-" + fontSize] = metricsObj;
            doc.body.removeChild(container);
            return metricsObj
        }
    })();
    (function(){
        var Util = _html2canvas.Util, Generate = {};
        _html2canvas.Generate = Generate;
        var reGradients = [/^(-webkit-linear-gradient)\(([a-z\s]+)([\w\d\.\s,%\(\)]+)\)$/, /^(-o-linear-gradient)\(([a-z\s]+)([\w\d\.\s,%\(\)]+)\)$/, /^(-webkit-gradient)\((linear|radial),\s((?:\d{1,3}%?)\s(?:\d{1,3}%?),\s(?:\d{1,3}%?)\s(?:\d{1,3}%?))([\w\d\.\s,%\(\)\-]+)\)$/, /^(-moz-linear-gradient)\(((?:\d{1,3}%?)\s(?:\d{1,3}%?))([\w\d\.\s,%\(\)]+)\)$/, /^(-webkit-radial-gradient)\(((?:\d{1,3}%?)\s(?:\d{1,3}%?)),\s(\w+)\s([a-z\-]+)([\w\d\.\s,%\(\)]+)\)$/, /^(-moz-radial-gradient)\(((?:\d{1,3}%?)\s(?:\d{1,3}%?)),\s(\w+)\s?([a-z\-]*)([\w\d\.\s,%\(\)]+)\)$/, /^(-o-radial-gradient)\(((?:\d{1,3}%?)\s(?:\d{1,3}%?)),\s(\w+)\s([a-z\-]+)([\w\d\.\s,%\(\)]+)\)$/];
        Generate.parseGradient = function(css, bounds){
            var gradient, i, len = reGradients.length, m1, stop, m2, m2Len, step, m3, tl, tr, br, bl;
            for(i = 0 ; i < len ; i += 1)
            {
                m1 = css.match(reGradients[i]);
                if(m1)
                {
                    break
                }
            }
            if(m1)
            {
                switch(m1[1])
                {
                    case"-webkit-linear-gradient":
                    case"-o-linear-gradient":
                        gradient = {type: "linear", x0: null, y0: null, x1: null, y1: null, colorStops: []};
                        m2 = m1[2].match(/\w+/g);
                        if(m2)
                        {
                            m2Len = m2.length;
                            for(i = 0 ; i < m2Len ; i += 1)
                            {
                                switch(m2[i])
                                {
                                    case"top":
                                        gradient.y0 = 0;
                                        gradient.y1 = bounds.height;
                                        break;
                                    case"right":
                                        gradient.x0 = bounds.width;
                                        gradient.x1 = 0;
                                        break;
                                    case"bottom":
                                        gradient.y0 = bounds.height;
                                        gradient.y1 = 0;
                                        break;
                                    case"left":
                                        gradient.x0 = 0;
                                        gradient.x1 = bounds.width;
                                        break
                                }
                            }
                        }
                        if(gradient.x0 === null && gradient.x1 === null)
                        {
                            gradient.x0 = gradient.x1 = bounds.width / 2
                        }
                        if(gradient.y0 === null && gradient.y1 === null)
                        {
                            gradient.y0 = gradient.y1 = bounds.height / 2
                        }
                        m2 = m1[3].match(/((?:rgb|rgba)\(\d{1,3},\s\d{1,3},\s\d{1,3}(?:,\s[0-9\.]+)?\)(?:\s\d{1,3}(?:%|px))?)+/g);
                        if(m2)
                        {
                            m2Len = m2.length;
                            step = 1 / Math.max(m2Len - 1, 1);
                            for(i = 0 ; i < m2Len ; i += 1)
                            {
                                m3 = m2[i].match(/((?:rgb|rgba)\(\d{1,3},\s\d{1,3},\s\d{1,3}(?:,\s[0-9\.]+)?\))\s*(\d{1,3})?(%|px)?/);
                                if(m3[2])
                                {
                                    stop = parseFloat(m3[2]);
                                    if(m3[3] === "%")
                                    {
                                        stop /= 100
                                    }
                                    else
                                    {
                                        stop /= bounds.width
                                    }
                                }
                                else
                                {
                                    stop = i * step
                                }
                                gradient.colorStops.push({color: m3[1], stop: stop})
                            }
                        }
                        break;
                    case"-webkit-gradient":
                        gradient = {
                            type      : m1[2] === "radial"? "circle" : m1[2],
                            x0        : 0,
                            y0        : 0,
                            x1        : 0,
                            y1        : 0,
                            colorStops: []
                        };
                        m2 = m1[3].match(/(\d{1,3})%?\s(\d{1,3})%?,\s(\d{1,3})%?\s(\d{1,3})%?/);
                        if(m2)
                        {
                            gradient.x0 = (m2[1] * bounds.width) / 100;
                            gradient.y0 = (m2[2] * bounds.height) / 100;
                            gradient.x1 = (m2[3] * bounds.width) / 100;
                            gradient.y1 = (m2[4] * bounds.height) / 100
                        }
                        m2 = m1[4].match(/((?:from|to|color-stop)\((?:[0-9\.]+,\s)?(?:rgb|rgba)\(\d{1,3},\s\d{1,3},\s\d{1,3}(?:,\s[0-9\.]+)?\)\))+/g);
                        if(m2)
                        {
                            m2Len = m2.length;
                            for(i = 0 ; i < m2Len ; i += 1)
                            {
                                m3 = m2[i].match(/(from|to|color-stop)\(([0-9\.]+)?(?:,\s)?((?:rgb|rgba)\(\d{1,3},\s\d{1,3},\s\d{1,3}(?:,\s[0-9\.]+)?\))\)/);
                                stop = parseFloat(m3[2]);
                                if(m3[1] === "from")
                                {
                                    stop = 0
                                }
                                if(m3[1] === "to")
                                {
                                    stop = 1
                                }
                                gradient.colorStops.push({color: m3[3], stop: stop})
                            }
                        }
                        break;
                    case"-moz-linear-gradient":
                        gradient = {type: "linear", x0: 0, y0: 0, x1: 0, y1: 0, colorStops: []};
                        m2 = m1[2].match(/(\d{1,3})%?\s(\d{1,3})%?/);
                        if(m2)
                        {
                            gradient.x0 = (m2[1] * bounds.width) / 100;
                            gradient.y0 = (m2[2] * bounds.height) / 100;
                            gradient.x1 = bounds.width - gradient.x0;
                            gradient.y1 = bounds.height - gradient.y0
                        }
                        m2 = m1[3].match(/((?:rgb|rgba)\(\d{1,3},\s\d{1,3},\s\d{1,3}(?:,\s[0-9\.]+)?\)(?:\s\d{1,3}%)?)+/g);
                        if(m2)
                        {
                            m2Len = m2.length;
                            step = 1 / Math.max(m2Len - 1, 1);
                            for(i = 0 ; i < m2Len ; i += 1)
                            {
                                m3 = m2[i].match(/((?:rgb|rgba)\(\d{1,3},\s\d{1,3},\s\d{1,3}(?:,\s[0-9\.]+)?\))\s*(\d{1,3})?(%)?/);
                                if(m3[2])
                                {
                                    stop = parseFloat(m3[2]);
                                    if(m3[3])
                                    {
                                        stop /= 100
                                    }
                                }
                                else
                                {
                                    stop = i * step
                                }
                                gradient.colorStops.push({color: m3[1], stop: stop})
                            }
                        }
                        break;
                    case"-webkit-radial-gradient":
                    case"-moz-radial-gradient":
                    case"-o-radial-gradient":
                        gradient = {
                            type      : "circle",
                            x0        : 0,
                            y0        : 0,
                            x1        : bounds.width,
                            y1        : bounds.height,
                            cx        : 0,
                            cy        : 0,
                            rx        : 0,
                            ry        : 0,
                            colorStops: []
                        };
                        m2 = m1[2].match(/(\d{1,3})%?\s(\d{1,3})%?/);
                        if(m2)
                        {
                            gradient.cx = (m2[1] * bounds.width) / 100;
                            gradient.cy = (m2[2] * bounds.height) / 100
                        }
                        m2 = m1[3].match(/\w+/);
                        m3 = m1[4].match(/[a-z\-]*/);
                        if(m2 && m3)
                        {
                            switch(m3[0])
                            {
                                case"farthest-corner":
                                case"cover":
                                case"":
                                    tl = Math.sqrt(Math.pow(gradient.cx, 2) + Math.pow(gradient.cy, 2));
                                    tr = Math.sqrt(Math.pow(gradient.cx, 2) + Math.pow(gradient.y1 - gradient.cy, 2));
                                    br = Math.sqrt(Math.pow(gradient.x1 - gradient.cx, 2) + Math.pow(gradient.y1 - gradient.cy, 2));
                                    bl = Math.sqrt(Math.pow(gradient.x1 - gradient.cx, 2) + Math.pow(gradient.cy, 2));
                                    gradient.rx = gradient.ry = Math.max(tl, tr, br, bl);
                                    break;
                                case"closest-corner":
                                    tl = Math.sqrt(Math.pow(gradient.cx, 2) + Math.pow(gradient.cy, 2));
                                    tr = Math.sqrt(Math.pow(gradient.cx, 2) + Math.pow(gradient.y1 - gradient.cy, 2));
                                    br = Math.sqrt(Math.pow(gradient.x1 - gradient.cx, 2) + Math.pow(gradient.y1 - gradient.cy, 2));
                                    bl = Math.sqrt(Math.pow(gradient.x1 - gradient.cx, 2) + Math.pow(gradient.cy, 2));
                                    gradient.rx = gradient.ry = Math.min(tl, tr, br, bl);
                                    break;
                                case"farthest-side":
                                    if(m2[0] === "circle")
                                    {
                                        gradient.rx = gradient.ry = Math.max(gradient.cx, gradient.cy, gradient.x1 - gradient.cx, gradient.y1 - gradient.cy)
                                    }
                                    else
                                    {
                                        gradient.type = m2[0];
                                        gradient.rx = Math.max(gradient.cx, gradient.x1 - gradient.cx);
                                        gradient.ry = Math.max(gradient.cy, gradient.y1 - gradient.cy)
                                    }
                                    break;
                                case"closest-side":
                                case"contain":
                                    if(m2[0] === "circle")
                                    {
                                        gradient.rx = gradient.ry = Math.min(gradient.cx, gradient.cy, gradient.x1 - gradient.cx, gradient.y1 - gradient.cy)
                                    }
                                    else
                                    {
                                        gradient.type = m2[0];
                                        gradient.rx = Math.min(gradient.cx, gradient.x1 - gradient.cx);
                                        gradient.ry = Math.min(gradient.cy, gradient.y1 - gradient.cy)
                                    }
                                    break
                            }
                        }
                        m2 = m1[5].match(/((?:rgb|rgba)\(\d{1,3},\s\d{1,3},\s\d{1,3}(?:,\s[0-9\.]+)?\)(?:\s\d{1,3}(?:%|px))?)+/g);
                        if(m2)
                        {
                            m2Len = m2.length;
                            step = 1 / Math.max(m2Len - 1, 1);
                            for(i = 0 ; i < m2Len ; i += 1)
                            {
                                m3 = m2[i].match(/((?:rgb|rgba)\(\d{1,3},\s\d{1,3},\s\d{1,3}(?:,\s[0-9\.]+)?\))\s*(\d{1,3})?(%|px)?/);
                                if(m3[2])
                                {
                                    stop = parseFloat(m3[2]);
                                    if(m3[3] === "%")
                                    {
                                        stop /= 100
                                    }
                                    else
                                    {
                                        stop /= bounds.width
                                    }
                                }
                                else
                                {
                                    stop = i * step
                                }
                                gradient.colorStops.push({color: m3[1], stop: stop})
                            }
                        }
                        break
                }
            }
            return gradient
        };

        function addScrollStops(grad)
        {
            return function(colorStop){
                try
                {
                    grad.addColorStop(colorStop.stop, colorStop.color)
                }
                catch(e)
                {
                    Util.log(["failed to add color stop: ", e, "; tried to add: ", colorStop])
                }
            }
        }

        Generate.Gradient = function(src, bounds){
            if(bounds.width === 0 || bounds.height === 0)
            {
                return
            }
            var canvas = document.createElement("canvas"), ctx = canvas.getContext("2d"), gradient, grad;
            canvas.width = bounds.width;
            canvas.height = bounds.height;
            gradient = _html2canvas.Generate.parseGradient(src, bounds);
            if(gradient)
            {
                switch(gradient.type)
                {
                    case"linear":
                        grad = ctx.createLinearGradient(gradient.x0, gradient.y0, gradient.x1, gradient.y1);
                        gradient.colorStops.forEach(addScrollStops(grad));
                        ctx.fillStyle = grad;
                        ctx.fillRect(0, 0, bounds.width, bounds.height);
                        break;
                    case"circle":
                        grad = ctx.createRadialGradient(gradient.cx, gradient.cy, 0, gradient.cx, gradient.cy, gradient.rx);
                        gradient.colorStops.forEach(addScrollStops(grad));
                        ctx.fillStyle = grad;
                        ctx.fillRect(0, 0, bounds.width, bounds.height);
                        break;
                    case"ellipse":
                        var canvasRadial = document.createElement("canvas"), ctxRadial = canvasRadial.getContext("2d");
                        ctxRadial.fillStyle = "white";
                        ctxRadial.fillRect(0, 0, canvasRadial.width, canvasRadial.height);
                        var ri = Math.max(gradient.rx, gradient.ry), di = ri * 2;
                        canvasRadial.width = canvasRadial.height = di;
                        grad = ctxRadial.createRadialGradient(gradient.rx, gradient.ry, 0, gradient.rx, gradient.ry, ri);
                        gradient.colorStops.forEach(addScrollStops(grad));
                        ctxRadial.fillStyle = grad;
                        ctxRadial.fillRect(0, 0, di, di);
                        ctx.fillStyle = gradient.colorStops[gradient.colorStops.length - 1].color;
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(canvasRadial, gradient.cx - gradient.rx, gradient.cy - gradient.ry, 2 * gradient.rx, 2 * gradient.ry);
                        break
                }
            }
            return canvas
        };
        Generate.ListAlpha = function(number){
            var tmp = "", modulus;
            do
            {
                modulus = number % 26;
                tmp = String.fromCharCode((modulus) + 64) + tmp;
                number = number / 26
            }while((number * 26) > 26);
            return tmp
        };
        Generate.ListRoman = function(number){
            var romanArray = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"],
                decimal = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1], roman = "", v,
                len = romanArray.length;
            if(number <= 0 || number >= 4000)
            {
                return number
            }
            for(v = 0 ; v < len ; v += 1)
            {
                while(number >= decimal[v])
                {
                    number -= decimal[v];
                    roman += romanArray[v]
                }
            }
            return roman
        }
    })();

    function h2cRenderContext(width, height)
    {
        var storage = [];
        return {
            storage         : storage, width: width, height: height, clip: function(){
                storage.push({type: "function", name: "clip", "arguments": arguments})
            }, translate    : function(){
                storage.push({type: "function", name: "translate", "arguments": arguments})
            }, fill         : function(){
                storage.push({type: "function", name: "fill", "arguments": arguments})
            }, save         : function(){
                storage.push({type: "function", name: "save", "arguments": arguments})
            }, restore      : function(){
                storage.push({type: "function", name: "restore", "arguments": arguments})
            }, fillRect     : function(){
                storage.push({type: "function", name: "fillRect", "arguments": arguments})
            }, createPattern: function(){
                storage.push({type: "function", name: "createPattern", "arguments": arguments})
            }, drawShape    : function(){
                var shape = [];
                storage.push({type: "function", name: "drawShape", "arguments": shape});
                return {
                    moveTo             : function(){
                        shape.push({name: "moveTo", "arguments": arguments})
                    }, lineTo          : function(){
                        shape.push({name: "lineTo", "arguments": arguments})
                    }, arcTo           : function(){
                        shape.push({name: "arcTo", "arguments": arguments})
                    }, bezierCurveTo   : function(){
                        shape.push({name: "bezierCurveTo", "arguments": arguments})
                    }, quadraticCurveTo: function(){
                        shape.push({name: "quadraticCurveTo", "arguments": arguments})
                    }
                }
            }, drawImage    : function(){
                storage.push({type: "function", name: "drawImage", "arguments": arguments})
            }, fillText     : function(){
                storage.push({type: "function", name: "fillText", "arguments": arguments})
            }, setVariable  : function(variable, value){
                storage.push({type: "variable", name: variable, "arguments": value});
                return value
            }
        }
    }

    _html2canvas.Parse = function(images, options){
        window.scroll(0, 0);
        var element = ((options.elements === undefined)? document.body : options.elements[0]), numDraws = 0,
            doc = element.ownerDocument, Util = _html2canvas.Util, support = Util.Support(options, doc),
            ignoreElementsRegExp = new RegExp("(" + options.ignoreElements + ")"), body = doc.body,
            getCSS = Util.getCSS, pseudoHide = "___html2canvas___pseudoelement",
            hidePseudoElements = doc.createElement("style");
        hidePseudoElements.innerHTML = "." + pseudoHide + '-before:before { content: "" !important; display: none !important; }.' + pseudoHide + '-after:after { content: "" !important; display: none !important; }';
        body.appendChild(hidePseudoElements);
        images = images || {};

        function documentWidth()
        {
            return Math.max(Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth), Math.max(doc.body.offsetWidth, doc.documentElement.offsetWidth), Math.max(doc.body.clientWidth, doc.documentElement.clientWidth))
        }

        function documentHeight()
        {
            return Math.max(Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight), Math.max(doc.body.offsetHeight, doc.documentElement.offsetHeight), Math.max(doc.body.clientHeight, doc.documentElement.clientHeight))
        }

        function getCSSInt(element, attribute)
        {
            var val = parseInt(getCSS(element, attribute), 10);
            return (isNaN(val))? 0 : val
        }

        function renderRect(ctx, x, y, w, h, bgcolor)
        {
            if(bgcolor !== "transparent")
            {
                ctx.setVariable("fillStyle", bgcolor);
                ctx.fillRect(x, y, w, h);
                numDraws += 1
            }
        }

        function capitalize(m, p1, p2)
        {
            if(m.length > 0)
            {
                return p1 + p2.toUpperCase()
            }
        }

        function textTransform(text, transform)
        {
            switch(transform)
            {
                case"lowercase":
                    return text.toLowerCase();
                case"capitalize":
                    return text.replace(/(^|\s|:|-|\(|\))([a-z])/g, capitalize);
                case"uppercase":
                    return text.toUpperCase();
                default:
                    return text
            }
        }

        function noLetterSpacing(letter_spacing)
        {
            return (/^(normal|none|0px)$/.test(letter_spacing))
        }

        function drawText(currentText, x, y, ctx)
        {
            if(currentText !== null && Util.trimText(currentText).length > 0)
            {
                ctx.fillText(currentText, x, y);
                numDraws += 1
            }
        }

        function setTextVariables(ctx, el, text_decoration, color)
        {
            var align = false, bold = getCSS(el, "fontWeight"), family = getCSS(el, "fontFamily"),
                size = getCSS(el, "fontSize"), shadows = Util.parseTextShadows(getCSS(el, "textShadow"));
            switch(parseInt(bold, 10))
            {
                case 401:
                    bold = "bold";
                    break;
                case 400:
                    bold = "normal";
                    break
            }
            ctx.setVariable("fillStyle", color);
            ctx.setVariable("font", [getCSS(el, "fontStyle"), getCSS(el, "fontVariant"), bold, size, family].join(" "));
            ctx.setVariable("textAlign", (align)? "right" : "left");
            if(shadows.length)
            {
                ctx.setVariable("shadowColor", shadows[0].color);
                ctx.setVariable("shadowOffsetX", shadows[0].offsetX);
                ctx.setVariable("shadowOffsetY", shadows[0].offsetY);
                ctx.setVariable("shadowBlur", shadows[0].blur)
            }
            if(text_decoration !== "none")
            {
                return Util.Font(family, size, doc)
            }
        }

        function renderTextDecoration(ctx, text_decoration, bounds, metrics, color)
        {
            switch(text_decoration)
            {
                case"underline":
                    renderRect(ctx, bounds.left, Math.round(bounds.top + metrics.baseline + metrics.lineWidth), bounds.width, 1, color);
                    break;
                case"overline":
                    renderRect(ctx, bounds.left, Math.round(bounds.top), bounds.width, 1, color);
                    break;
                case"line-through":
                    renderRect(ctx, bounds.left, Math.ceil(bounds.top + metrics.middle + metrics.lineWidth), bounds.width, 1, color);
                    break
            }
        }

        function getTextBounds(state, text, textDecoration, isLast, transform)
        {
            var bounds;
            if(support.rangeBounds && !transform)
            {
                if(textDecoration !== "none" || Util.trimText(text).length !== 0)
                {
                    bounds = textRangeBounds(text, state.node, state.textOffset)
                }
                state.textOffset += text.length
            }
            else
            {
                if(state.node && typeof state.node.nodeValue === "string")
                {
                    var newTextNode = (isLast)? state.node.splitText(text.length) : null;
                    bounds = textWrapperBounds(state.node, transform);
                    state.node = newTextNode
                }
            }
            return bounds
        }

        function textRangeBounds(text, textNode, textOffset)
        {
            var range = doc.createRange();
            range.setStart(textNode, textOffset);
            range.setEnd(textNode, textOffset + text.length);
            return range.getBoundingClientRect()
        }

        function textWrapperBounds(oldTextNode, transform)
        {
            var parent = oldTextNode.parentNode, wrapElement = doc.createElement("wrapper"),
                backupText = oldTextNode.cloneNode(true);
            wrapElement.appendChild(oldTextNode.cloneNode(true));
            parent.replaceChild(wrapElement, oldTextNode);
            var bounds = transform? Util.OffsetBounds(wrapElement) : Util.Bounds(wrapElement);
            parent.replaceChild(backupText, wrapElement);
            return bounds
        }

        function renderText(el, textNode, stack)
        {
            var ctx = stack.ctx, color = getCSS(el, "color"), textDecoration = getCSS(el, "textDecoration"),
                textAlign = getCSS(el, "textAlign"), metrics, textList, state = {node: textNode, textOffset: 0};
            if(Util.trimText(textNode.nodeValue).length > 0)
            {
                textNode.nodeValue = textTransform(textNode.nodeValue, getCSS(el, "textTransform"));
                textAlign = textAlign.replace(["-webkit-auto"], ["auto"]);
                textList = (!options.letterRendering && /^(left|right|justify|auto)$/.test(textAlign) && noLetterSpacing(getCSS(el, "letterSpacing")))? textNode.nodeValue.split(/(\b| )/) : textNode.nodeValue.split("");
                metrics = setTextVariables(ctx, el, textDecoration, color);
                if(options.chinese)
                {
                    textList.forEach(function(word, index){
                        if(/.*[\u4E00-\u9FA5].*$/.test(word))
                        {
                            word = word.split("");
                            word.unshift(index, 1);
                            textList.splice.apply(textList, word)
                        }
                    })
                }
                textList.forEach(function(text, index){
                    var bounds = getTextBounds(state, text, textDecoration, (index < textList.length - 1), stack.transform.matrix);
                    if(bounds)
                    {
                        drawText(text, bounds.left, bounds.bottom, ctx);
                        renderTextDecoration(ctx, textDecoration, bounds, metrics, color)
                    }
                })
            }
        }

        function listPosition(element, val)
        {
            var boundElement = doc.createElement("boundelement"), originalType, bounds;
            boundElement.style.display = "inline";
            originalType = element.style.listStyleType;
            element.style.listStyleType = "none";
            boundElement.appendChild(doc.createTextNode(val));
            element.insertBefore(boundElement, element.firstChild);
            bounds = Util.Bounds(boundElement);
            element.removeChild(boundElement);
            element.style.listStyleType = originalType;
            return bounds
        }

        function elementIndex(el)
        {
            var i = -1, count = 1, childs = el.parentNode.childNodes;
            if(el.parentNode)
            {
                while(childs[++i] !== el)
                {
                    if(childs[i].nodeType === 1)
                    {
                        count++
                    }
                }
                return count
            }
            else
            {
                return -1
            }
        }

        function listItemText(element, type)
        {
            var currentIndex = elementIndex(element), text;
            switch(type)
            {
                case"decimal":
                    text = currentIndex;
                    break;
                case"decimal-leading-zero":
                    text = (currentIndex.toString().length === 1)? currentIndex = "0" + currentIndex.toString() : currentIndex.toString();
                    break;
                case"upper-roman":
                    text = _html2canvas.Generate.ListRoman(currentIndex);
                    break;
                case"lower-roman":
                    text = _html2canvas.Generate.ListRoman(currentIndex).toLowerCase();
                    break;
                case"lower-alpha":
                    text = _html2canvas.Generate.ListAlpha(currentIndex).toLowerCase();
                    break;
                case"upper-alpha":
                    text = _html2canvas.Generate.ListAlpha(currentIndex);
                    break
            }
            return text + ". "
        }

        function renderListItem(element, stack, elBounds)
        {
            var x, text, ctx = stack.ctx, type = getCSS(element, "listStyleType"), listBounds;
            if(/^(decimal|decimal-leading-zero|upper-alpha|upper-latin|upper-roman|lower-alpha|lower-greek|lower-latin|lower-roman)$/i.test(type))
            {
                text = listItemText(element, type);
                listBounds = listPosition(element, text);
                setTextVariables(ctx, element, "none", getCSS(element, "color"));
                if(getCSS(element, "listStylePosition") === "inside")
                {
                    ctx.setVariable("textAlign", "left");
                    x = elBounds.left
                }
                else
                {
                    return
                }
                drawText(text, x, listBounds.bottom, ctx)
            }
        }

        function loadImage(src)
        {
            var img = images[src];
            return (img && img.succeeded === true)? img.img : false
        }

        function clipBounds(src, dst)
        {
            var x = Math.max(src.left, dst.left), y = Math.max(src.top, dst.top),
                x2 = Math.min((src.left + src.width), (dst.left + dst.width)),
                y2 = Math.min((src.top + src.height), (dst.top + dst.height));
            return {left: x, top: y, width: x2 - x, height: y2 - y}
        }

        function setZ(element, stack, parentStack)
        {
            var newContext, isPositioned = stack.cssPosition !== "static",
                zIndex = isPositioned? getCSS(element, "zIndex") : "auto", opacity = getCSS(element, "opacity"),
                isFloated = getCSS(element, "cssFloat") !== "none";
            stack.zIndex = newContext = h2czContext(zIndex);
            newContext.isPositioned = isPositioned;
            newContext.isFloated = isFloated;
            newContext.opacity = opacity;
            newContext.ownStacking = (zIndex !== "auto" || opacity < 1);
            if(parentStack)
            {
                parentStack.zIndex.children.push(stack)
            }
        }

        function renderImage(ctx, element, image, bounds, borders)
        {
            var paddingLeft = getCSSInt(element, "paddingLeft"), paddingTop = getCSSInt(element, "paddingTop"),
                paddingRight = getCSSInt(element, "paddingRight"), paddingBottom = getCSSInt(element, "paddingBottom");
            drawImage(ctx, image, 0, 0, image.width, image.height, bounds.left + paddingLeft + borders[3].width, bounds.top + paddingTop + borders[0].width, bounds.width - (borders[1].width + borders[3].width + paddingLeft + paddingRight), bounds.height - (borders[0].width + borders[2].width + paddingTop + paddingBottom))
        }

        function getBorderData(element)
        {
            return ["Top", "Right", "Bottom", "Left"].map(function(side){
                return {
                    width: getCSSInt(element, "border" + side + "Width"),
                    color: getCSS(element, "border" + side + "Color")
                }
            })
        }

        function getBorderRadiusData(element)
        {
            return ["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map(function(side){
                return getCSS(element, "border" + side + "Radius")
            })
        }

        var getCurvePoints = (function(kappa){
            return function(x, y, r1, r2){
                var ox = (r1) * kappa, oy = (r2) * kappa, xm = x + r1, ym = y + r2;
                return {
                    topLeft    : bezierCurve({x: x, y: ym}, {x: x, y: ym - oy}, {x: xm - ox, y: y}, {x: xm, y: y}),
                    topRight   : bezierCurve({x: x, y: y}, {x: x + ox, y: y}, {x: xm, y: ym - oy}, {x: xm, y: ym}),
                    bottomRight: bezierCurve({x: xm, y: y}, {x: xm, y: y + oy}, {x: x + ox, y: ym}, {x: x, y: ym}),
                    bottomLeft : bezierCurve({x: xm, y: ym}, {x: xm - ox, y: ym}, {x: x, y: y + oy}, {x: x, y: y})
                }
            }
        })(4 * ((Math.sqrt(2) - 1) / 3));

        function bezierCurve(start, startControl, endControl, end)
        {
            var lerp = function(a, b, t){
                return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t}
            };
            return {
                start          : start,
                startControl   : startControl,
                endControl     : endControl,
                end            : end,
                subdivide      : function(t){
                    var ab = lerp(start, startControl, t), bc = lerp(startControl, endControl, t),
                        cd = lerp(endControl, end, t), abbc = lerp(ab, bc, t), bccd = lerp(bc, cd, t),
                        dest = lerp(abbc, bccd, t);
                    return [bezierCurve(start, ab, abbc, dest), bezierCurve(dest, bccd, cd, end)]
                },
                curveTo        : function(borderArgs){
                    borderArgs.push(["bezierCurve", startControl.x, startControl.y, endControl.x, endControl.y, end.x, end.y])
                },
                curveToReversed: function(borderArgs){
                    borderArgs.push(["bezierCurve", endControl.x, endControl.y, startControl.x, startControl.y, start.x, start.y])
                }
            }
        }

        function parseCorner(borderArgs, radius1, radius2, corner1, corner2, x, y)
        {
            if(radius1[0] > 0 || radius1[1] > 0)
            {
                borderArgs.push(["line", corner1[0].start.x, corner1[0].start.y]);
                corner1[0].curveTo(borderArgs);
                corner1[1].curveTo(borderArgs)
            }
            else
            {
                borderArgs.push(["line", x, y])
            }
            if(radius2[0] > 0 || radius2[1] > 0)
            {
                borderArgs.push(["line", corner2[0].start.x, corner2[0].start.y])
            }
        }

        function drawSide(borderData, radius1, radius2, outer1, inner1, outer2, inner2)
        {
            var borderArgs = [];
            if(radius1[0] > 0 || radius1[1] > 0)
            {
                borderArgs.push(["line", outer1[1].start.x, outer1[1].start.y]);
                outer1[1].curveTo(borderArgs)
            }
            else
            {
                borderArgs.push(["line", borderData.c1[0], borderData.c1[1]])
            }
            if(radius2[0] > 0 || radius2[1] > 0)
            {
                borderArgs.push(["line", outer2[0].start.x, outer2[0].start.y]);
                outer2[0].curveTo(borderArgs);
                borderArgs.push(["line", inner2[0].end.x, inner2[0].end.y]);
                inner2[0].curveToReversed(borderArgs)
            }
            else
            {
                borderArgs.push(["line", borderData.c2[0], borderData.c2[1]]);
                borderArgs.push(["line", borderData.c3[0], borderData.c3[1]])
            }
            if(radius1[0] > 0 || radius1[1] > 0)
            {
                borderArgs.push(["line", inner1[1].end.x, inner1[1].end.y]);
                inner1[1].curveToReversed(borderArgs)
            }
            else
            {
                borderArgs.push(["line", borderData.c4[0], borderData.c4[1]])
            }
            return borderArgs
        }

        function calculateCurvePoints(bounds, borderRadius, borders)
        {
            var x = bounds.left, y = bounds.top, width = bounds.width, height = bounds.height, tlh = borderRadius[0][0],
                tlv = borderRadius[0][1], trh = borderRadius[1][0], trv = borderRadius[1][1], brh = borderRadius[2][0],
                brv = borderRadius[2][1], blh = borderRadius[3][0], blv = borderRadius[3][1], topWidth = width - trh,
                rightHeight = height - brv, bottomWidth = width - brh, leftHeight = height - blv;
            return {
                topLeftOuter    : getCurvePoints(x, y, tlh, tlv).topLeft.subdivide(0.5),
                topLeftInner    : getCurvePoints(x + borders[3].width, y + borders[0].width, Math.max(0, tlh - borders[3].width), Math.max(0, tlv - borders[0].width)).topLeft.subdivide(0.5),
                topRightOuter   : getCurvePoints(x + topWidth, y, trh, trv).topRight.subdivide(0.5),
                topRightInner   : getCurvePoints(x + Math.min(topWidth, width + borders[3].width), y + borders[0].width, (topWidth > width + borders[3].width)? 0 : trh - borders[3].width, trv - borders[0].width).topRight.subdivide(0.5),
                bottomRightOuter: getCurvePoints(x + bottomWidth, y + rightHeight, brh, brv).bottomRight.subdivide(0.5),
                bottomRightInner: getCurvePoints(x + Math.min(bottomWidth, width + borders[3].width), y + Math.min(rightHeight, height + borders[0].width), Math.max(0, brh - borders[1].width), Math.max(0, brv - borders[2].width)).bottomRight.subdivide(0.5),
                bottomLeftOuter : getCurvePoints(x, y + leftHeight, blh, blv).bottomLeft.subdivide(0.5),
                bottomLeftInner : getCurvePoints(x + borders[3].width, y + leftHeight, Math.max(0, blh - borders[3].width), Math.max(0, blv - borders[2].width)).bottomLeft.subdivide(0.5)
            }
        }

        function getBorderClip(element, borderPoints, borders, radius, bounds)
        {
            var backgroundClip = getCSS(element, "backgroundClip"), borderArgs = [];
            switch(backgroundClip)
            {
                case"content-box":
                case"padding-box":
                    parseCorner(borderArgs, radius[0], radius[1], borderPoints.topLeftInner, borderPoints.topRightInner, bounds.left + borders[3].width, bounds.top + borders[0].width);
                    parseCorner(borderArgs, radius[1], radius[2], borderPoints.topRightInner, borderPoints.bottomRightInner, bounds.left + bounds.width - borders[1].width, bounds.top + borders[0].width);
                    parseCorner(borderArgs, radius[2], radius[3], borderPoints.bottomRightInner, borderPoints.bottomLeftInner, bounds.left + bounds.width - borders[1].width, bounds.top + bounds.height - borders[2].width);
                    parseCorner(borderArgs, radius[3], radius[0], borderPoints.bottomLeftInner, borderPoints.topLeftInner, bounds.left + borders[3].width, bounds.top + bounds.height - borders[2].width);
                    break;
                default:
                    parseCorner(borderArgs, radius[0], radius[1], borderPoints.topLeftOuter, borderPoints.topRightOuter, bounds.left, bounds.top);
                    parseCorner(borderArgs, radius[1], radius[2], borderPoints.topRightOuter, borderPoints.bottomRightOuter, bounds.left + bounds.width, bounds.top);
                    parseCorner(borderArgs, radius[2], radius[3], borderPoints.bottomRightOuter, borderPoints.bottomLeftOuter, bounds.left + bounds.width, bounds.top + bounds.height);
                    parseCorner(borderArgs, radius[3], radius[0], borderPoints.bottomLeftOuter, borderPoints.topLeftOuter, bounds.left, bounds.top + bounds.height);
                    break
            }
            return borderArgs
        }

        function parseBorders(element, bounds, borders)
        {
            var x = bounds.left, y = bounds.top, width = bounds.width, height = bounds.height, borderSide, bx, by, bw,
                bh, borderArgs, borderRadius = getBorderRadiusData(element),
                borderPoints = calculateCurvePoints(bounds, borderRadius, borders),
                borderData = {clip: getBorderClip(element, borderPoints, borders, borderRadius, bounds), borders: []};
            for(borderSide = 0 ; borderSide < 4 ; borderSide++)
            {
                if(borders[borderSide].width > 0)
                {
                    bx = x;
                    by = y;
                    bw = width;
                    bh = height - (borders[2].width);
                    switch(borderSide)
                    {
                        case 0:
                            bh = borders[0].width;
                            borderArgs = drawSide({
                                c1: [bx, by],
                                c2: [bx + bw, by],
                                c3: [bx + bw - borders[1].width, by + bh],
                                c4: [bx + borders[3].width, by + bh]
                            }, borderRadius[0], borderRadius[1], borderPoints.topLeftOuter, borderPoints.topLeftInner, borderPoints.topRightOuter, borderPoints.topRightInner);
                            break;
                        case 1:
                            bx = x + width - (borders[1].width);
                            bw = borders[1].width;
                            borderArgs = drawSide({
                                c1: [bx + bw, by],
                                c2: [bx + bw, by + bh + borders[2].width],
                                c3: [bx, by + bh],
                                c4: [bx, by + borders[0].width]
                            }, borderRadius[1], borderRadius[2], borderPoints.topRightOuter, borderPoints.topRightInner, borderPoints.bottomRightOuter, borderPoints.bottomRightInner);
                            break;
                        case 2:
                            by = (by + height) - (borders[2].width);
                            bh = borders[2].width;
                            borderArgs = drawSide({
                                c1: [bx + bw, by + bh],
                                c2: [bx, by + bh],
                                c3: [bx + borders[3].width, by],
                                c4: [bx + bw - borders[3].width, by]
                            }, borderRadius[2], borderRadius[3], borderPoints.bottomRightOuter, borderPoints.bottomRightInner, borderPoints.bottomLeftOuter, borderPoints.bottomLeftInner);
                            break;
                        case 3:
                            bw = borders[3].width;
                            borderArgs = drawSide({
                                c1: [bx, by + bh + borders[2].width],
                                c2: [bx, by],
                                c3: [bx + bw, by + borders[0].width],
                                c4: [bx + bw, by + bh]
                            }, borderRadius[3], borderRadius[0], borderPoints.bottomLeftOuter, borderPoints.bottomLeftInner, borderPoints.topLeftOuter, borderPoints.topLeftInner);
                            break
                    }
                    borderData.borders.push({args: borderArgs, color: borders[borderSide].color})
                }
            }
            return borderData
        }

        function createShape(ctx, args)
        {
            var shape = ctx.drawShape();
            args.forEach(function(border, index){
                shape[(index === 0)? "moveTo" : border[0] + "To"].apply(null, border.slice(1))
            });
            return shape
        }

        function renderBorders(ctx, borderArgs, color)
        {
            if(color !== "transparent")
            {
                ctx.setVariable("fillStyle", color);
                createShape(ctx, borderArgs);
                ctx.fill();
                numDraws += 1
            }
        }

        function renderFormValue(el, bounds, stack)
        {
            var valueWrap = doc.createElement("valuewrap"),
                cssPropertyArray = ["lineHeight", "textAlign", "fontFamily", "color", "fontSize", "paddingLeft", "paddingTop", "width", "height", "border", "borderLeftWidth", "borderTopWidth"],
                textValue, textNode;
            cssPropertyArray.forEach(function(property){
                try
                {
                    valueWrap.style[property] = getCSS(el, property)
                }
                catch(e)
                {
                    Util.log("html2canvas: Parse: Exception caught in renderFormValue: " + e.message)
                }
            });
            valueWrap.style.borderColor = "black";
            valueWrap.style.borderStyle = "solid";
            valueWrap.style.display = "block";
            valueWrap.style.position = "absolute";
            if(/^(submit|reset|button|text|password)$/.test(el.type) || el.nodeName === "SELECT")
            {
                valueWrap.style.lineHeight = getCSS(el, "height")
            }
            valueWrap.style.top = bounds.top + "px";
            valueWrap.style.left = bounds.left + "px";
            textValue = (el.nodeName === "SELECT")? (el.options[el.selectedIndex] || 0).text : el.value;
            if(!textValue)
            {
                textValue = el.placeholder
            }
            textNode = doc.createTextNode(textValue);
            valueWrap.appendChild(textNode);
            body.appendChild(valueWrap);
            renderText(el, textNode, stack);
            body.removeChild(valueWrap)
        }

        function drawImage(ctx)
        {
            ctx.drawImage.apply(ctx, Array.prototype.slice.call(arguments, 1));
            numDraws += 1
        }

        function getPseudoElement(el, which)
        {
            var elStyle = window.getComputedStyle(el, which);
            if(!elStyle || !elStyle.content || elStyle.content === "none" || elStyle.content === "-moz-alt-content" || elStyle.display === "none")
            {
                return
            }
            var content = elStyle.content + "", first = content.substr(0, 1);
            if(first === content.substr(content.length - 1) && first.match(/'|"/))
            {
                content = content.substr(1, content.length - 2)
            }
            var isImage = content.substr(0, 3) === "url", elps = document.createElement(isImage? "img" : "span");
            elps.className = pseudoHide + "-before " + pseudoHide + "-after";
            Object.keys(elStyle).filter(indexedProperty).forEach(function(prop){
                try
                {
                    elps.style[prop] = elStyle[prop]
                }
                catch(e)
                {
                    Util.log(["Tried to assign readonly property ", prop, "Error:", e])
                }
            });
            if(isImage)
            {
                elps.src = Util.parseBackgroundImage(content)[0].args[0]
            }
            else
            {
                elps.innerHTML = content
            }
            return elps
        }

        function indexedProperty(property)
        {
            return (isNaN(window.parseInt(property, 10)))
        }

        function injectPseudoElements(el, stack)
        {
            var before = getPseudoElement(el, ":before"), after = getPseudoElement(el, ":after");
            if(!before && !after)
            {
                return
            }
            if(before)
            {
                el.className += " " + pseudoHide + "-before";
                el.parentNode.insertBefore(before, el);
                parseElement(before, stack, true);
                el.parentNode.removeChild(before);
                el.className = el.className.replace(pseudoHide + "-before", "").trim()
            }
            if(after)
            {
                el.className += " " + pseudoHide + "-after";
                el.appendChild(after);
                parseElement(after, stack, true);
                el.removeChild(after);
                el.className = el.className.replace(pseudoHide + "-after", "").trim()
            }
        }

        function renderBackgroundRepeat(ctx, image, backgroundPosition, bounds)
        {
            var offsetX = Math.round(bounds.left + backgroundPosition.left),
                offsetY = Math.round(bounds.top + backgroundPosition.top);
            ctx.createPattern(image);
            ctx.translate(offsetX, offsetY);
            ctx.fill();
            ctx.translate(-offsetX, -offsetY)
        }

        function backgroundRepeatShape(ctx, image, backgroundPosition, bounds, left, top, width, height)
        {
            var args = [];
            args.push(["line", Math.round(left), Math.round(top)]);
            args.push(["line", Math.round(left + width), Math.round(top)]);
            args.push(["line", Math.round(left + width), Math.round(height + top)]);
            args.push(["line", Math.round(left), Math.round(height + top)]);
            createShape(ctx, args);
            ctx.save();
            ctx.clip();
            renderBackgroundRepeat(ctx, image, backgroundPosition, bounds);
            ctx.restore()
        }

        function renderBackgroundColor(ctx, backgroundBounds, bgcolor)
        {
            renderRect(ctx, backgroundBounds.left, backgroundBounds.top, backgroundBounds.width, backgroundBounds.height, bgcolor)
        }

        function renderBackgroundRepeating(el, bounds, ctx, image, imageIndex)
        {
            var backgroundSize = Util.BackgroundSize(el, bounds, image, imageIndex),
                backgroundPosition = Util.BackgroundPosition(el, bounds, image, imageIndex, backgroundSize),
                backgroundRepeat = getCSS(el, "backgroundRepeat").split(",").map(Util.trimText);
            image = resizeImage(image, backgroundSize);
            backgroundRepeat = backgroundRepeat[imageIndex] || backgroundRepeat[0];
            switch(backgroundRepeat)
            {
                case"repeat-x":
                    backgroundRepeatShape(ctx, image, backgroundPosition, bounds, bounds.left, bounds.top + backgroundPosition.top, 99999, image.height);
                    break;
                case"repeat-y":
                    backgroundRepeatShape(ctx, image, backgroundPosition, bounds, bounds.left + backgroundPosition.left, bounds.top, image.width, 99999);
                    break;
                case"no-repeat":
                    backgroundRepeatShape(ctx, image, backgroundPosition, bounds, bounds.left + backgroundPosition.left, bounds.top + backgroundPosition.top, image.width, image.height);
                    break;
                default:
                    renderBackgroundRepeat(ctx, image, backgroundPosition, {
                        top   : bounds.top,
                        left  : bounds.left,
                        width : image.width,
                        height: image.height
                    });
                    break
            }
        }

        function renderBackgroundImage(element, bounds, ctx)
        {
            var backgroundImage = getCSS(element, "backgroundImage"),
                backgroundImages = Util.parseBackgroundImage(backgroundImage), image,
                imageIndex = backgroundImages.length;
            while(imageIndex--)
            {
                backgroundImage = backgroundImages[imageIndex];
                if(!backgroundImage.args || backgroundImage.args.length === 0)
                {
                    continue
                }
                var key = backgroundImage.method === "url"? backgroundImage.args[0] : backgroundImage.value;
                image = loadImage(key);
                if(image)
                {
                    renderBackgroundRepeating(element, bounds, ctx, image, imageIndex)
                }
                else
                {
                    Util.log("html2canvas: Error loading background:", backgroundImage)
                }
            }
        }

        function resizeImage(image, bounds)
        {
            if(image.width === bounds.width && image.height === bounds.height)
            {
                return image
            }
            var ctx, canvas = doc.createElement("canvas");
            canvas.width = bounds.width;
            canvas.height = bounds.height;
            ctx = canvas.getContext("2d");
            drawImage(ctx, image, 0, 0, image.width, image.height, 0, 0, bounds.width, bounds.height);
            return canvas
        }

        function setOpacity(ctx, element, parentStack)
        {
            return ctx.setVariable("globalAlpha", getCSS(element, "opacity") * ((parentStack)? parentStack.opacity : 1))
        }

        function removePx(str)
        {
            return str.replace("px", "")
        }

        var transformRegExp = /(matrix)\((.+)\)/;

        function getTransform(element, parentStack)
        {
            var transform = getCSS(element, "transform") || getCSS(element, "-webkit-transform") || getCSS(element, "-moz-transform") || getCSS(element, "-ms-transform") || getCSS(element, "-o-transform");
            var transformOrigin = getCSS(element, "transform-origin") || getCSS(element, "-webkit-transform-origin") || getCSS(element, "-moz-transform-origin") || getCSS(element, "-ms-transform-origin") || getCSS(element, "-o-transform-origin") || "0px 0px";
            transformOrigin = transformOrigin.split(" ").map(removePx).map(Util.asFloat);
            var matrix;
            if(transform && transform !== "none")
            {
                var match = transform.match(transformRegExp);
                if(match)
                {
                    switch(match[1])
                    {
                        case"matrix":
                            matrix = match[2].split(",").map(Util.trimText).map(Util.asFloat);
                            break
                    }
                }
            }
            return {origin: transformOrigin, matrix: matrix}
        }

        function createStack(element, parentStack, bounds, transform)
        {
            var ctx = h2cRenderContext((!parentStack)? documentWidth() : bounds.width, (!parentStack)? documentHeight() : bounds.height),
                stack = {
                    ctx: ctx,
                    opacity: setOpacity(ctx, element, parentStack),
                    cssPosition: getCSS(element, "position"),
                    borders: getBorderData(element),
                    transform: transform,
                    clip: (parentStack && parentStack.clip)? Util.Extend({}, parentStack.clip) : null
                };
            setZ(element, stack, parentStack);
            if(options.useOverflow === true && /(hidden|scroll|auto)/.test(getCSS(element, "overflow")) === true && /(BODY)/i.test(element.nodeName) === false)
            {
                stack.clip = (stack.clip)? clipBounds(stack.clip, bounds) : bounds
            }
            return stack
        }

        function getBackgroundBounds(borders, bounds, clip)
        {
            var backgroundBounds = {
                left  : bounds.left + borders[3].width,
                top   : bounds.top + borders[0].width,
                width : bounds.width - (borders[1].width + borders[3].width),
                height: bounds.height - (borders[0].width + borders[2].width)
            };
            if(clip)
            {
                backgroundBounds = clipBounds(backgroundBounds, clip)
            }
            return backgroundBounds
        }

        function getBounds(element, transform)
        {
            var bounds = (transform.matrix)? Util.OffsetBounds(element) : Util.Bounds(element);
            transform.origin[0] += bounds.left;
            transform.origin[1] += bounds.top;
            return bounds
        }

        function renderElement(element, parentStack, pseudoElement, ignoreBackground)
        {
            var transform = getTransform(element, parentStack), bounds = getBounds(element, transform), image,
                stack = createStack(element, parentStack, bounds, transform), borders = stack.borders, ctx = stack.ctx,
                backgroundBounds = getBackgroundBounds(borders, bounds, stack.clip),
                borderData = parseBorders(element, bounds, borders),
                backgroundColor = (ignoreElementsRegExp.test(element.nodeName))? "#efefef" : getCSS(element, "backgroundColor");
            createShape(ctx, borderData.clip);
            ctx.save();
            ctx.clip();
            if(backgroundBounds.height > 0 && backgroundBounds.width > 0 && !ignoreBackground)
            {
                renderBackgroundColor(ctx, bounds, backgroundColor);
                renderBackgroundImage(element, backgroundBounds, ctx)
            }
            else
            {
                if(ignoreBackground)
                {
                    stack.backgroundColor = backgroundColor
                }
            }
            ctx.restore();
            borderData.borders.forEach(function(border){
                renderBorders(ctx, border.args, border.color)
            });
            if(!pseudoElement)
            {
                injectPseudoElements(element, stack)
            }
            switch(element.nodeName)
            {
                case"IMG":
                    if((image = loadImage(element.getAttribute("src"))))
                    {
                        renderImage(ctx, element, image, bounds, borders)
                    }
                    else
                    {
                        Util.log("html2canvas: Error loading <img>:" + element.getAttribute("src"))
                    }
                    break;
                case"INPUT":
                    if(/^(text|url|email|submit|button|reset)$/.test(element.type) && (element.value || element.placeholder || "").length > 0)
                    {
                        renderFormValue(element, bounds, stack)
                    }
                    break;
                case"TEXTAREA":
                    if((element.value || element.placeholder || "").length > 0)
                    {
                        renderFormValue(element, bounds, stack)
                    }
                    break;
                case"SELECT":
                    if((element.options || element.placeholder || "").length > 0)
                    {
                        renderFormValue(element, bounds, stack)
                    }
                    break;
                case"LI":
                    renderListItem(element, stack, backgroundBounds);
                    break;
                case"CANVAS":
                    renderImage(ctx, element, element, bounds, borders);
                    break
            }
            return stack
        }

        function isElementVisible(element)
        {
            return (getCSS(element, "display") !== "none" && getCSS(element, "visibility") !== "hidden" && !element.hasAttribute("data-html2canvas-ignore"))
        }

        function parseElement(element, stack, pseudoElement)
        {
            if(isElementVisible(element))
            {
                stack = renderElement(element, stack, pseudoElement, false) || stack;
                if(!ignoreElementsRegExp.test(element.nodeName))
                {
                    parseChildren(element, stack, pseudoElement)
                }
            }
        }

        function parseChildren(element, stack, pseudoElement)
        {
            Util.Children(element).forEach(function(node){
                if(node.nodeType === node.ELEMENT_NODE)
                {
                    parseElement(node, stack, pseudoElement)
                }
                else
                {
                    if(node.nodeType === node.TEXT_NODE)
                    {
                        renderText(element, node, stack)
                    }
                }
            })
        }

        function init()
        {
            var background = getCSS(document.documentElement, "backgroundColor"),
                transparentBackground = (Util.isTransparent(background) && element === document.body),
                stack = renderElement(element, null, false, transparentBackground);
            parseChildren(element, stack);
            if(transparentBackground)
            {
                background = stack.backgroundColor
            }
            body.removeChild(hidePseudoElements);
            return {backgroundColor: background, stack: stack}
        }

        return init()
    };

    function h2czContext(zindex)
    {
        return {zindex: zindex, children: []}
    }

    _html2canvas.Preload = function(options){
        var images = {numLoaded: 0, numFailed: 0, numTotal: 0, cleanupDone: false}, pageOrigin,
            Util = _html2canvas.Util, methods, i, count = 0, element = options.elements[0] || document.body,
            doc = element.ownerDocument, domImages = element.getElementsByTagName("img"), imgLen = domImages.length,
            link = doc.createElement("a"), supportCORS = (function(img){
                return (img.crossOrigin !== undefined)
            })(new Image()), timeoutTimer;
        link.href = window.location.href;
        pageOrigin = link.protocol + link.host;

        function isSameOrigin(url)
        {
            link.href = url;
            link.href = link.href;
            var origin = link.protocol + link.host;
            return (origin === pageOrigin)
        }

        function start()
        {
            Util.log("html2canvas: start: images: " + images.numLoaded + " / " + images.numTotal + " (failed: " + images.numFailed + ")");
            if(!images.firstRun && images.numLoaded >= images.numTotal)
            {
                Util.log("Finished loading images: # " + images.numTotal + " (failed: " + images.numFailed + ")");
                if(typeof options.complete === "function")
                {
                    options.complete(images)
                }
            }
        }

        function proxyGetImage(url, img, imageObj)
        {
            var callback_name, scriptUrl = options.proxy, script;
            link.href = url;
            url = link.href;
            callback_name = "html2canvas_" + (count++);
            imageObj.callbackname = callback_name;
            if(scriptUrl.indexOf("?") > -1)
            {
                scriptUrl += "&"
            }
            else
            {
                scriptUrl += "?"
            }
            scriptUrl += "url=" + encodeURIComponent(url) + "&callback=" + callback_name;
            script = doc.createElement("script");
            window[callback_name] = function(a){
                if(a.substring(0, 6) === "error:")
                {
                    imageObj.succeeded = false;
                    images.numLoaded++;
                    images.numFailed++;
                    start()
                }
                else
                {
                    setImageLoadHandlers(img, imageObj);
                    img.src = a
                }
                window[callback_name] = undefined;
                try
                {
                    delete window[callback_name]
                }
                catch(ex)
                {
                }
                script.parentNode.removeChild(script);
                script = null;
                delete imageObj.script;
                delete imageObj.callbackname
            };
            script.setAttribute("type", "text/javascript");
            script.setAttribute("src", scriptUrl);
            imageObj.script = script;
            window.document.body.appendChild(script)
        }

        function loadPseudoElement(element, type)
        {
            var style = window.getComputedStyle(element, type), content = style.content;
            if(content.substr(0, 3) === "url")
            {
                methods.loadImage(_html2canvas.Util.parseBackgroundImage(content)[0].args[0])
            }
            loadBackgroundImages(style.backgroundImage, element)
        }

        function loadPseudoElementImages(element)
        {
            loadPseudoElement(element, ":before");
            loadPseudoElement(element, ":after")
        }

        function loadGradientImage(backgroundImage, bounds)
        {
            var img = _html2canvas.Generate.Gradient(backgroundImage, bounds);
            if(img !== undefined)
            {
                images[backgroundImage] = {img: img, succeeded: true};
                images.numTotal++;
                images.numLoaded++;
                start()
            }
        }

        function invalidBackgrounds(background_image)
        {
            return (background_image && background_image.method && background_image.args && background_image.args.length > 0)
        }

        function loadBackgroundImages(background_image, el)
        {
            var bounds;
            _html2canvas.Util.parseBackgroundImage(background_image).filter(invalidBackgrounds).forEach(function(background_image){
                if(background_image.method === "url")
                {
                    methods.loadImage(background_image.args[0])
                }
                else
                {
                    if(background_image.method.match(/\-?gradient$/))
                    {
                        if(bounds === undefined)
                        {
                            bounds = _html2canvas.Util.Bounds(el)
                        }
                        loadGradientImage(background_image.value, bounds)
                    }
                }
            })
        }

        function getImages(el)
        {
            var elNodeType = false;
            try
            {
                Util.Children(el).forEach(getImages)
            }
            catch(e)
            {
            }
            try
            {
                elNodeType = el.nodeType
            }
            catch(ex)
            {
                elNodeType = false;
                Util.log("html2canvas: failed to access some element's nodeType - Exception: " + ex.message)
            }
            if(elNodeType === 1 || elNodeType === undefined)
            {
                loadPseudoElementImages(el);
                try
                {
                    loadBackgroundImages(Util.getCSS(el, "backgroundImage"), el)
                }
                catch(e)
                {
                    Util.log("html2canvas: failed to get background-image - Exception: " + e.message)
                }
                loadBackgroundImages(el)
            }
        }

        function setImageLoadHandlers(img, imageObj)
        {
            img.onload = function(){
                if(imageObj.timer !== undefined)
                {
                    window.clearTimeout(imageObj.timer)
                }
                images.numLoaded++;
                imageObj.succeeded = true;
                img.onerror = img.onload = null;
                start()
            };
            img.onerror = function(){
                if(img.crossOrigin === "anonymous")
                {
                    window.clearTimeout(imageObj.timer);
                    if(options.proxy)
                    {
                        var src = img.src;
                        img = new Image();
                        imageObj.img = img;
                        img.src = src;
                        proxyGetImage(img.src, img, imageObj);
                        return
                    }
                }
                images.numLoaded++;
                images.numFailed++;
                imageObj.succeeded = false;
                img.onerror = img.onload = null;
                start()
            }
        }

        methods = {
            loadImage       : function(src){
                var img, imageObj;
                if(src && images[src] === undefined)
                {
                    img = new Image();
                    if(src.match(/data:image\/.*;base64,/i))
                    {
                        img.src = src.replace(/url\(['"]{0,}|['"]{0,}\)$/ig, "");
                        imageObj = images[src] = {img: img};
                        images.numTotal++;
                        setImageLoadHandlers(img, imageObj)
                    }
                    else
                    {
                        if(isSameOrigin(src) || options.allowTaint === true)
                        {
                            imageObj = images[src] = {img: img};
                            images.numTotal++;
                            setImageLoadHandlers(img, imageObj);
                            img.src = src
                        }
                        else
                        {
                            if(supportCORS && !options.allowTaint && options.useCORS)
                            {
                                img.crossOrigin = "anonymous";
                                imageObj = images[src] = {img: img};
                                images.numTotal++;
                                setImageLoadHandlers(img, imageObj);
                                img.src = src
                            }
                            else
                            {
                                if(options.proxy)
                                {
                                    imageObj = images[src] = {img: img};
                                    images.numTotal++;
                                    proxyGetImage(src, img, imageObj)
                                }
                            }
                        }
                    }
                }
            }, cleanupDOM   : function(cause){
                var img, src;
                if(!images.cleanupDone)
                {
                    if(cause && typeof cause === "string")
                    {
                        Util.log("html2canvas: Cleanup because: " + cause)
                    }
                    else
                    {
                        Util.log("html2canvas: Cleanup after timeout: " + options.timeout + " ms.")
                    }
                    for(src in images)
                    {
                        if(images.hasOwnProperty(src))
                        {
                            img = images[src];
                            if(typeof img === "object" && img.callbackname && img.succeeded === undefined)
                            {
                                window[img.callbackname] = undefined;
                                try
                                {
                                    delete window[img.callbackname]
                                }
                                catch(ex)
                                {
                                }
                                if(img.script && img.script.parentNode)
                                {
                                    img.script.setAttribute("src", "about:blank");
                                    img.script.parentNode.removeChild(img.script)
                                }
                                images.numLoaded++;
                                images.numFailed++;
                                Util.log("html2canvas: Cleaned up failed img: '" + src + "' Steps: " + images.numLoaded + " / " + images.numTotal)
                            }
                        }
                    }
                    if(window.stop !== undefined)
                    {
                        window.stop()
                    }
                    else
                    {
                        if(document.execCommand !== undefined)
                        {
                            document.execCommand("Stop", false)
                        }
                    }
                    if(document.close !== undefined)
                    {
                        document.close()
                    }
                    images.cleanupDone = true;
                    if(!(cause && typeof cause === "string"))
                    {
                        start()
                    }
                }
            }, renderingDone: function(){
                if(timeoutTimer)
                {
                    window.clearTimeout(timeoutTimer)
                }
            }
        };
        if(options.timeout > 0)
        {
            timeoutTimer = window.setTimeout(methods.cleanupDOM, options.timeout)
        }
        Util.log("html2canvas: Preload starts: finding background-images");
        images.firstRun = true;
        getImages(element);
        Util.log("html2canvas: Preload: Finding images");
        for(i = 0 ; i < imgLen ; i += 1)
        {
            methods.loadImage(domImages[i].getAttribute("src"))
        }
        images.firstRun = false;
        Util.log("html2canvas: Preload: Done.");
        if(images.numTotal === images.numLoaded)
        {
            start()
        }
        return methods
    };
    _html2canvas.Renderer = function(parseQueue, options){
        function createRenderQueue(parseQueue)
        {
            var queue = [], rootContext;
            rootContext = (function buildStackingContext(rootNode){
                var rootContext = {};

                function insert(context, node, specialParent)
                {
                    var zi = (node.zIndex.zindex === "auto")? 0 : Number(node.zIndex.zindex),
                        contextForChildren = context, isPositioned = node.zIndex.isPositioned,
                        isFloated = node.zIndex.isFloated, stub = {node: node}, childrenDest = specialParent;
                    if(node.zIndex.ownStacking)
                    {
                        contextForChildren = stub.context = {"!": [{node: node, children: []}]};
                        childrenDest = undefined
                    }
                    else
                    {
                        if(isPositioned || isFloated)
                        {
                            childrenDest = stub.children = []
                        }
                    }
                    if(zi === 0 && specialParent)
                    {
                        specialParent.push(stub)
                    }
                    else
                    {
                        if(!context[zi])
                        {
                            context[zi] = []
                        }
                        context[zi].push(stub)
                    }
                    node.zIndex.children.forEach(function(childNode){
                        insert(contextForChildren, childNode, childrenDest)
                    })
                }

                insert(rootContext, rootNode);
                return rootContext
            })(parseQueue);

            function sortZ(context)
            {
                Object.keys(context).sort().forEach(function(zi){
                    var nonPositioned = [], floated = [], positioned = [], list = [];
                    context[zi].forEach(function(v){
                        if(v.node.zIndex.isPositioned || v.node.zIndex.opacity < 1)
                        {
                            positioned.push(v)
                        }
                        else
                        {
                            if(v.node.zIndex.isFloated)
                            {
                                floated.push(v)
                            }
                            else
                            {
                                nonPositioned.push(v)
                            }
                        }
                    });
                    (function walk(arr){
                        arr.forEach(function(v){
                            list.push(v);
                            if(v.children)
                            {
                                walk(v.children)
                            }
                        })
                    })(nonPositioned.concat(floated, positioned));
                    list.forEach(function(v){
                        if(v.context)
                        {
                            sortZ(v.context)
                        }
                        else
                        {
                            queue.push(v.node)
                        }
                    })
                })
            }

            sortZ(rootContext);
            return queue
        }

        function getRenderer(rendererName)
        {
            var renderer;
            if(typeof options.renderer === "string" && _html2canvas.Renderer[rendererName] !== undefined)
            {
                renderer = _html2canvas.Renderer[rendererName](options)
            }
            else
            {
                if(typeof rendererName === "function")
                {
                    renderer = rendererName(options)
                }
                else
                {
                    throw new Error("Unknown renderer")
                }
            }
            if(typeof renderer !== "function")
            {
                throw new Error("Invalid renderer defined")
            }
            return renderer
        }

        return getRenderer(options.renderer)(parseQueue, options, document, createRenderQueue(parseQueue.stack), _html2canvas)
    };
    _html2canvas.Util.Support = function(options, doc){
        function supportSVGRendering()
        {
            var img = new Image(), canvas = doc.createElement("canvas"),
                ctx = (canvas.getContext === undefined)? false : canvas.getContext("2d");
            if(ctx === false)
            {
                return false
            }
            canvas.width = canvas.height = 10;
            img.src = ["data:image/svg+xml,", "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'>", "<foreignObject width='10' height='10'>", "<div xmlns='http://www.w3.org/1999/xhtml' style='width:10;height:10;'>", "sup", "</div>", "</foreignObject>", "</svg>"].join("");
            try
            {
                ctx.drawImage(img, 0, 0);
                canvas.toDataURL()
            }
            catch(e)
            {
                return false
            }
            _html2canvas.Util.log("html2canvas: Parse: SVG powered rendering available");
            return true
        }

        function supportRangeBounds()
        {
            var r, testElement, rangeBounds, rangeHeight, support = false;
            if(doc.createRange)
            {
                r = doc.createRange();
                if(r.getBoundingClientRect)
                {
                    testElement = doc.createElement("boundtest");
                    testElement.style.height = "123px";
                    testElement.style.display = "block";
                    doc.body.appendChild(testElement);
                    r.selectNode(testElement);
                    rangeBounds = r.getBoundingClientRect();
                    rangeHeight = rangeBounds.height;
                    if(rangeHeight === 123)
                    {
                        support = true
                    }
                    doc.body.removeChild(testElement)
                }
            }
            return support
        }

        return {rangeBounds: supportRangeBounds(), svgRendering: options.svgRendering && supportSVGRendering()}
    };
    window.html2canvas = function(elements, opts){
        elements = (elements.length)? elements : [elements];
        var queue, canvas, options = {
            logging        : false,
            elements       : elements,
            background     : "#fff",
            proxy          : null,
            timeout        : 0,
            useCORS        : false,
            allowTaint     : false,
            svgRendering   : false,
            ignoreElements : "IFRAME|OBJECT|PARAM",
            useOverflow    : true,
            letterRendering: false,
            chinese        : false,
            width          : null,
            height         : null,
            taintTest      : true,
            renderer       : "Canvas"
        };
        options = _html2canvas.Util.Extend(opts, options);
        _html2canvas.logging = options.logging;
        options.complete = function(images){
            if(typeof options.onpreloaded === "function")
            {
                if(options.onpreloaded(images) === false)
                {
                    return
                }
            }
            queue = _html2canvas.Parse(images, options);
            if(typeof options.onparsed === "function")
            {
                if(options.onparsed(queue) === false)
                {
                    return
                }
            }
            canvas = _html2canvas.Renderer(queue, options);
            if(typeof options.onrendered === "function")
            {
                options.onrendered(canvas)
            }
        };
        window.setTimeout(function(){
            _html2canvas.Preload(options)
        }, 0);
        return {
            render    : function(queue, opts){
                return _html2canvas.Renderer(queue, _html2canvas.Util.Extend(opts, options))
            }, parse  : function(images, opts){
                return _html2canvas.Parse(images, _html2canvas.Util.Extend(opts, options))
            }, preload: function(opts){
                return _html2canvas.Preload(_html2canvas.Util.Extend(opts, options))
            }, log    : _html2canvas.Util.log
        }
    };
    window.html2canvas.log = _html2canvas.Util.log;
    window.html2canvas.Renderer = {Canvas: undefined};
    _html2canvas.Renderer.Canvas = function(options){
        options = options || {};
        var doc = document, safeImages = [], testCanvas = document.createElement("canvas"),
            testctx = testCanvas.getContext("2d"), Util = _html2canvas.Util,
            canvas = options.canvas || doc.createElement("canvas");

        function createShape(ctx, args)
        {
            ctx.beginPath();
            args.forEach(function(arg){
                ctx[arg.name].apply(ctx, arg["arguments"])
            });
            ctx.closePath()
        }

        function safeImage(item)
        {
            if(safeImages.indexOf(item["arguments"][0].src) === -1)
            {
                testctx.drawImage(item["arguments"][0], 0, 0);
                try
                {
                    testctx.getImageData(0, 0, 1, 1)
                }
                catch(e)
                {
                    testCanvas = doc.createElement("canvas");
                    testctx = testCanvas.getContext("2d");
                    return false
                }
                safeImages.push(item["arguments"][0].src)
            }
            return true
        }

        function renderItem(ctx, item)
        {
            switch(item.type)
            {
                case"variable":
                    ctx[item.name] = item["arguments"];
                    break;
                case"function":
                    switch(item.name)
                    {
                        case"createPattern":
                            if(item["arguments"][0].width > 0 && item["arguments"][0].height > 0)
                            {
                                try
                                {
                                    ctx.fillStyle = ctx.createPattern(item["arguments"][0], "repeat")
                                }
                                catch(e)
                                {
                                    Util.log("html2canvas: Renderer: Error creating pattern", e.message)
                                }
                            }
                            break;
                        case"drawShape":
                            createShape(ctx, item["arguments"]);
                            break;
                        case"drawImage":
                            if(item["arguments"][8] > 0 && item["arguments"][7] > 0)
                            {
                                if(!options.taintTest || (options.taintTest && safeImage(item)))
                                {
                                    ctx.drawImage.apply(ctx, item["arguments"])
                                }
                            }
                            break;
                        default:
                            ctx[item.name].apply(ctx, item["arguments"])
                    }
                    break
            }
        }

        return function(parsedData, options, document, queue, _html2canvas){
            var ctx = canvas.getContext("2d"), newCanvas, bounds, fstyle, zStack = parsedData.stack;
            canvas.width = canvas.style.width = options.width || zStack.ctx.width;
            canvas.height = canvas.style.height = options.height || zStack.ctx.height;
            fstyle = ctx.fillStyle;
            ctx.fillStyle = (Util.isTransparent(zStack.backgroundColor) && options.background !== undefined)? options.background : parsedData.backgroundColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = fstyle;
            queue.forEach(function(storageContext){
                ctx.textBaseline = "bottom";
                ctx.save();
                if(storageContext.transform.matrix)
                {
                    ctx.translate(storageContext.transform.origin[0], storageContext.transform.origin[1]);
                    ctx.transform.apply(ctx, storageContext.transform.matrix);
                    ctx.translate(-storageContext.transform.origin[0], -storageContext.transform.origin[1])
                }
                if(storageContext.clip)
                {
                    ctx.beginPath();
                    ctx.rect(storageContext.clip.left, storageContext.clip.top, storageContext.clip.width, storageContext.clip.height);
                    ctx.clip()
                }
                if(storageContext.ctx.storage)
                {
                    storageContext.ctx.storage.forEach(function(item){
                        renderItem(ctx, item)
                    })
                }
                ctx.restore()
            });
            Util.log("html2canvas: Renderer: Canvas renderer done - returning canvas obj");
            if(options.elements.length === 1)
            {
                if(typeof options.elements[0] === "object" && options.elements[0].nodeName !== "BODY")
                {
                    bounds = _html2canvas.Util.Bounds(options.elements[0]);
                    newCanvas = document.createElement("canvas");
                    newCanvas.width = Math.ceil(bounds.width);
                    newCanvas.height = Math.ceil(bounds.height);
                    ctx = newCanvas.getContext("2d");
                    ctx.fillStyle = "white";
                    ctx.fillRect(0, 0, newCanvas.width, newCanvas.height);
                    ctx.drawImage(canvas, bounds.left, bounds.top, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
                    canvas = null;
                    return newCanvas
                }
            }
            return canvas
        }
    }
})(window, document);

var labelTemplateString = "";
(function(){
    "use strict";
    var t = this, i = t.Chart, e = function(t){
        this.canvas = t.canvas, this.ctx = t;
        this.width = t.canvas.width, this.height = t.canvas.height;
        return this.aspectRatio = this.width / this.height, s.retinaScale(this), this
    };
    e.defaults = {
        global: {
            animation                : !0,
            animationSteps           : 60,
            animationEasing          : "easeOutQuart",
            showScale                : !0,
            scaleOverride            : !1,
            scaleSteps               : null,
            scaleStepWidth           : null,
            scaleStartValue          : null,
            scaleLineColor           : "rgba(0,0,0,.1)",
            scaleLineWidth           : 1,
            scaleShowLabels          : !0,
            scaleLabel               : "<%=value%>",
            scaleIntegersOnly        : !0,
            scaleBeginAtZero         : !1,
            scaleFontFamily          : "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
            scaleFontSize            : 12,
            scaleFontStyle           : "normal",
            scaleFontColor           : "#666",
            responsive               : !1,
            maintainAspectRatio      : !0,
            showTooltips             : !0,
            tooltipEvents            : ["mousemove", "touchstart", "touchmove", "mouseout"],
            tooltipFillColor         : "rgba(0,0,0,0.8)",
            tooltipFontFamily        : "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
            tooltipFontSize          : 14,
            tooltipFontStyle         : "normal",
            tooltipFontColor         : "#fff",
            tooltipTitleFontFamily   : "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
            tooltipTitleFontSize     : 14,
            tooltipTitleFontStyle    : "bold",
            tooltipTitleFontColor    : "#fff",
            tooltipYPadding          : 6,
            tooltipXPadding          : 6,
            tooltipCaretSize         : 8,
            tooltipCornerRadius      : 6,
            tooltipXOffset           : 10,
            tooltipTemplate          : "<%if (label){%><%=label%>: <%}%><%= value %>",
            multiTooltipTemplate     : "<%= value %>",
            multiTooltipKeyBackground: "#fff",
            onAnimationProgress      : function(){
            },
            onAnimationComplete      : function(){
            }
        }
    }, e.types = {};
    var s = e.helpers = {}, n = s.each = function(t, i, e){
        var s = Array.prototype.slice.call(arguments, 3);
        if(t) if(t.length === +t.length)
        {
            var n;
            for(n = 0 ; n < t.length ; n++) i.apply(e, [t[n], n].concat(s))
        }
        else for(var o in t) i.apply(e, [t[o], o].concat(s))
    }, o = s.clone = function(t){
        var i = {};
        return n(t, function(e, s){
            t.hasOwnProperty(s) && (i[s] = e)
        }), i
    }, a = s.extend = function(t){
        return n(Array.prototype.slice.call(arguments, 1), function(i){
            n(i, function(e, s){
                i.hasOwnProperty(s) && (t[s] = e)
            })
        }), t
    }, h = s.merge = function(){
        var t = Array.prototype.slice.call(arguments, 0);
        return t.unshift({}), a.apply(null, t)
    }, l = s.indexOf = function(t, i){
        if(Array.prototype.indexOf) return t.indexOf(i);
        for(var e = 0 ; e < t.length ; e++) if(t[e] === i) return e;
        return -1
    }, r = (s.where = function(t, i){
        var e = [];
        return s.each(t, function(t){
            i(t) && e.push(t)
        }), e
    }, s.findNextWhere = function(t, i, e){
        e || (e = -1);
        for(var s = e + 1 ; s < t.length ; s++)
        {
            var n = t[s];
            if(i(n)) return n
        }
    }, s.findPreviousWhere = function(t, i, e){
        e || (e = t.length);
        for(var s = e - 1 ; s >= 0 ; s--)
        {
            var n = t[s];
            if(i(n)) return n
        }
    }, s.inherits = function(t){
        var i = this, e = t && t.hasOwnProperty("constructor")? t.constructor : function(){
            return i.apply(this, arguments)
        }, s = function(){
            this.constructor = e
        };
        return s.prototype = i.prototype, e.prototype = new s, e.extend = r, t && a(e.prototype, t), e.__super__ = i.prototype, e
    }), c = s.noop = function(){
    }, u = s.uid = function(){
        var t = 0;
        return function(){
            return "chart-" + t++
        }
    }(), d = s.warn = function(t){
        window.console && "function" == typeof window.console.warn && console.warn(t)
    }, p = s.amd = "function" == typeof t.define && t.define.amd, f = s.isNumber = function(t){
        return !isNaN(parseFloat(t)) && isFinite(t)
    }, g = s.max = function(t){
        return Math.max.apply(Math, t)
    }, m = s.min = function(t){
        return Math.min.apply(Math, t)
    }, v = (s.cap = function(t, i, e){
        if(f(i))
        {
            if(t > i) return i
        }
        else if(f(e) && e > t) return e;
        return t
    }, s.getDecimalPlaces = function(t){
        return t % 1 !== 0 && f(t)? t.toString().split(".")[1].length : 0
    }), x = s.radians = function(t){
        return t * (Math.PI / 180)
    }, S = (s.getAngleFromPoint = function(t, i){
        var e = i.x - t.x, s = i.y - t.y, n = Math.sqrt(e * e + s * s), o = 2 * Math.PI + Math.atan2(s, e);
        return 0 > e && 0 > s && (o += 2 * Math.PI), {angle: o, distance: n}
    }, s.aliasPixel = function(t){
        return t % 2 === 0? 0 : .5
    }), y = (s.splineCurve = function(t, i, e, s){
        var n = Math.sqrt(Math.pow(i.x - t.x, 2) + Math.pow(i.y - t.y, 2)),
            o = Math.sqrt(Math.pow(e.x - i.x, 2) + Math.pow(e.y - i.y, 2)), a = s * n / (n + o), h = s * o / (n + o);
        return {
            inner: {x: i.x - a * (e.x - t.x), y: i.y - a * (e.y - t.y)},
            outer: {x: i.x + h * (e.x - t.x), y: i.y + h * (e.y - t.y)}
        }
    }, s.calculateOrderOfMagnitude = function(t){
        return Math.floor(Math.log(t) / Math.LN10)
    }), C = (s.calculateScaleRange = function(t, i, e, s, n){
        var o = 2, a = Math.floor(i / (1.5 * e)), h = o >= a, l = g(t), r = m(t);
        l === r && (l += .5, r >= .5 && !s? r -= .5 : l += .5);
        for(var c = Math.abs(l - r), u = y(c), d = Math.ceil(l / (1 * Math.pow(10, u))) * Math.pow(10, u), p = s? 0 : Math.floor(r / (1 * Math.pow(10, u))) * Math.pow(10, u), f = d - p, v = Math.pow(10, u), x = Math.round(f / v) ; (x > a || a > 2 * x) && !h ;) if(x > a) v *= 2, x = Math.round(f / v), x % 1 !== 0 && (h = !0);
        else if(n && u >= 0)
        {
            if(v / 2 % 1 !== 0) break;
            v /= 2, x = Math.round(f / v)
        }
        else v /= 2, x = Math.round(f / v);
        return h && (x = o, v = f / x), {steps: x, stepValue: v, min: p, max: p + x * v}
    }, s.template = function(t, i){
        function e(t, i)
        {
            var e = /\W/.test(t)? new Function("obj", "var p=[],print=function(){p.push.apply(p,arguments);};with(obj){p.push('" + t.replace(/[\r\t\n]/g, " ").split("<%").join("	").replace(/((^|%>)[^\t]*)'/g, "$1\r").replace(/\t=(.*?)%>/g, "',$1,'").split("	").join("');").split("%>").join("p.push('").split("\r").join("\\'") + "');}return p.join('');") : s[t] = s[t];
            return i? e(i) : e
        }

        if(t instanceof Function) return t(i);
        var s = {};
        return e(t, i)
    }), b = (s.generateLabels = function(t, i, e, s){
        var o = new Array(i);
        return labelTemplateString && n(o, function(i, n){
            o[n] = C(t, {value: e + s * (n + 1)})
        }), o
    }, s.easingEffects = {
        linear             : function(t){
            return t
        }, easeInQuad      : function(t){
            return t * t
        }, easeOutQuad     : function(t){
            return -1 * t * (t - 2)
        }, easeInOutQuad   : function(t){
            return (t /= .5) < 1? .5 * t * t : -0.5 * (--t * (t - 2) - 1)
        }, easeInCubic     : function(t){
            return t * t * t
        }, easeOutCubic    : function(t){
            return 1 * ((t = t / 1 - 1) * t * t + 1)
        }, easeInOutCubic  : function(t){
            return (t /= .5) < 1? .5 * t * t * t : .5 * ((t -= 2) * t * t + 2)
        }, easeInQuart     : function(t){
            return t * t * t * t
        }, easeOutQuart    : function(t){
            return -1 * ((t = t / 1 - 1) * t * t * t - 1)
        }, easeInOutQuart  : function(t){
            return (t /= .5) < 1? .5 * t * t * t * t : -0.5 * ((t -= 2) * t * t * t - 2)
        }, easeInQuint     : function(t){
            return 1 * (t /= 1) * t * t * t * t
        }, easeOutQuint    : function(t){
            return 1 * ((t = t / 1 - 1) * t * t * t * t + 1)
        }, easeInOutQuint  : function(t){
            return (t /= .5) < 1? .5 * t * t * t * t * t : .5 * ((t -= 2) * t * t * t * t + 2)
        }, easeInSine      : function(t){
            return -1 * Math.cos(t / 1 * (Math.PI / 2)) + 1
        }, easeOutSine     : function(t){
            return 1 * Math.sin(t / 1 * (Math.PI / 2))
        }, easeInOutSine   : function(t){
            return -0.5 * (Math.cos(Math.PI * t / 1) - 1)
        }, easeInExpo      : function(t){
            return 0 === t? 1 : 1 * Math.pow(2, 10 * (t / 1 - 1))
        }, easeOutExpo     : function(t){
            return 1 === t? 1 : 1 * (-Math.pow(2, -10 * t / 1) + 1)
        }, easeInOutExpo   : function(t){
            return 0 === t? 0 : 1 === t? 1 : (t /= .5) < 1? .5 * Math.pow(2, 10 * (t - 1)) : .5 * (-Math.pow(2, -10 * --t) + 2)
        }, easeInCirc      : function(t){
            return t >= 1? t : -1 * (Math.sqrt(1 - (t /= 1) * t) - 1)
        }, easeOutCirc     : function(t){
            return 1 * Math.sqrt(1 - (t = t / 1 - 1) * t)
        }, easeInOutCirc   : function(t){
            return (t /= .5) < 1? -0.5 * (Math.sqrt(1 - t * t) - 1) : .5 * (Math.sqrt(1 - (t -= 2) * t) + 1)
        }, easeInElastic   : function(t){
            var i = 1.70158, e = 0, s = 1;
            return 0 === t? 0 : 1 == (t /= 1)? 1 : (e || (e = .3), s < Math.abs(1)? (s = 1, i = e / 4) : i = e / (2 * Math.PI) * Math.asin(1 / s), -(s * Math.pow(2, 10 * (t -= 1)) * Math.sin(2 * (1 * t - i) * Math.PI / e)))
        }, easeOutElastic  : function(t){
            var i = 1.70158, e = 0, s = 1;
            return 0 === t? 0 : 1 == (t /= 1)? 1 : (e || (e = .3), s < Math.abs(1)? (s = 1, i = e / 4) : i = e / (2 * Math.PI) * Math.asin(1 / s), s * Math.pow(2, -10 * t) * Math.sin(2 * (1 * t - i) * Math.PI / e) + 1)
        }, easeInOutElastic: function(t){
            var i = 1.70158, e = 0, s = 1;
            return 0 === t? 0 : 2 == (t /= .5)? 1 : (e || (e = .3 * 1.5), s < Math.abs(1)? (s = 1, i = e / 4) : i = e / (2 * Math.PI) * Math.asin(1 / s), 1 > t? -.5 * s * Math.pow(2, 10 * (t -= 1)) * Math.sin(2 * (1 * t - i) * Math.PI / e) : s * Math.pow(2, -10 * (t -= 1)) * Math.sin(2 * (1 * t - i) * Math.PI / e) * .5 + 1)
        }, easeInBack      : function(t){
            var i = 1.70158;
            return 1 * (t /= 1) * t * ((i + 1) * t - i)
        }, easeOutBack     : function(t){
            var i = 1.70158;
            return 1 * ((t = t / 1 - 1) * t * ((i + 1) * t + i) + 1)
        }, easeInOutBack   : function(t){
            var i = 1.70158;
            return (t /= .5) < 1? .5 * t * t * (((i *= 1.525) + 1) * t - i) : .5 * ((t -= 2) * t * (((i *= 1.525) + 1) * t + i) + 2)
        }, easeInBounce    : function(t){
            return 1 - b.easeOutBounce(1 - t)
        }, easeOutBounce   : function(t){
            return (t /= 1) < 1 / 2.75? 7.5625 * t * t : 2 / 2.75 > t? 1 * (7.5625 * (t -= 1.5 / 2.75) * t + .75) : 2.5 / 2.75 > t? 1 * (7.5625 * (t -= 2.25 / 2.75) * t + .9375) : 1 * (7.5625 * (t -= 2.625 / 2.75) * t + .984375)
        }, easeInOutBounce : function(t){
            return .5 > t? .5 * b.easeInBounce(2 * t) : .5 * b.easeOutBounce(2 * t - 1) + .5
        }
    }), w = s.requestAnimFrame = function(){
        return window.requestAnimationFrame || window.webkitRequestAnimationFrame || window.mozRequestAnimationFrame || window.oRequestAnimationFrame || window.msRequestAnimationFrame || function(t){
            return window.setTimeout(t, 1e3 / 60)
        }
    }(), P = (s.cancelAnimFrame = function(){
        return window.cancelAnimationFrame || window.webkitCancelAnimationFrame || window.mozCancelAnimationFrame || window.oCancelAnimationFrame || window.msCancelAnimationFrame || function(t){
            return window.clearTimeout(t, 1e3 / 60)
        }
    }(), s.animationLoop = function(t, i, e, s, n, o){
        var a = 0, h = b[e] || b.linear, l = function(){
            a++;
            var e = a / i, r = h(e);
            t.call(o, r, e, a), s.call(o, r, e), i > a? o.animationFrame = w(l) : n.apply(o)
        };
        w(l)
    }, s.getRelativePosition = function(t){
        var i, e, s = t.originalEvent || t, n = t.currentTarget || t.srcElement, o = n.getBoundingClientRect();
        return s.touches? (i = s.touches[0].clientX - o.left, e = s.touches[0].clientY - o.top) : (i = s.clientX - o.left, e = s.clientY - o.top), {
            x: i,
            y: e
        }
    }, s.addEvent = function(t, i, e){
        t.addEventListener? t.addEventListener(i, e) : t.attachEvent? t.attachEvent("on" + i, e) : t["on" + i] = e
    }), L = s.removeEvent = function(t, i, e){
        t.removeEventListener? t.removeEventListener(i, e, !1) : t.detachEvent? t.detachEvent("on" + i, e) : t["on" + i] = c
    }, k = (s.bindEvents = function(t, i, e){
        t.events || (t.events = {}), n(i, function(i){
            t.events[i] = function(){
                e.apply(t, arguments)
            }, P(t.chart.canvas, i, t.events[i])
        })
    }, s.unbindEvents = function(t, i){
        n(i, function(i, e){
            L(t.chart.canvas, e, i)
        })
    }), F = s.getMaximumWidth = function(t){
        var i = t.parentNode;
        return i.clientWidth
    }, R = s.getMaximumHeight = function(t){
        var i = t.parentNode;
        return i.clientHeight
    }, A = (s.getMaximumSize = s.getMaximumWidth, s.retinaScale = function(t){
        var i = t.ctx, e = t.canvas.width, s = t.canvas.height;
        window.devicePixelRatio && (i.canvas.style.width = e + "px", i.canvas.style.height = s + "px", i.canvas.height = s * window.devicePixelRatio, i.canvas.width = e * window.devicePixelRatio, i.scale(window.devicePixelRatio, window.devicePixelRatio))
    }), T = s.clear = function(t){
        t.ctx.clearRect(0, 0, t.width, t.height)
    }, M = s.fontString = function(t, i, e){
        return i + " " + t + "px " + e
    }, W = s.longestText = function(t, i, e){
        t.font = i;
        var s = 0;
        return n(e, function(i){
            var e = t.measureText(i).width;
            s = e > s? e : s
        }), s
    }, z = s.drawRoundedRectangle = function(t, i, e, s, n, o){
        t.beginPath(), t.moveTo(i + o, e), t.lineTo(i + s - o, e), t.quadraticCurveTo(i + s, e, i + s, e + o), t.lineTo(i + s, e + n - o), t.quadraticCurveTo(i + s, e + n, i + s - o, e + n), t.lineTo(i + o, e + n), t.quadraticCurveTo(i, e + n, i, e + n - o), t.lineTo(i, e + o), t.quadraticCurveTo(i, e, i + o, e), t.closePath()
    };
    e.instances = {}, e.Type = function(t, i, s){
        this.options = i, this.chart = s, this.id = u(), e.instances[this.id] = this, i.responsive && this.resize(), this.initialize.call(this, t)
    }, a(e.Type.prototype, {
        initialize       : function(){
            return this
        }, clear         : function(){
            return T(this.chart), this
        }, stop          : function(){
            return s.cancelAnimFrame.call(t, this.animationFrame), this
        }, resize        : function(t){
            this.stop();
            var i = this.chart.canvas, e = F(this.chart.canvas),
                s = this.options.maintainAspectRatio? e / this.chart.aspectRatio : R(this.chart.canvas);
            return i.width = this.chart.width = e, i.height = this.chart.height = s, A(this.chart), "function" == typeof t && t.apply(this, Array.prototype.slice.call(arguments, 1)), this
        }, reflow        : c, render: function(t){
            return t && this.reflow(), this.options.animation && !t? s.animationLoop(this.draw, this.options.animationSteps, this.options.animationEasing, this.options.onAnimationProgress, this.options.onAnimationComplete, this) : (this.draw(), this.options.onAnimationComplete.call(this)), this
        }, generateLegend: function(){
            return C(this.options.legendTemplate, this)
        }, destroy       : function(){
            this.clear(), k(this, this.events), delete e.instances[this.id]
        }, showTooltip   : function(t, i){
            "undefined" == typeof this.activeElements && (this.activeElements = []);
            var o = function(t){
                var i = !1;
                return t.length !== this.activeElements.length? i = !0 : (n(t, function(t, e){
                    t !== this.activeElements[e] && (i = !0)
                }, this), i)
            }.call(this, t);
            if(o || i)
            {
                if(this.activeElements = t, this.draw(), t.length > 0) if(this.datasets && this.datasets.length > 1)
                {
                    for(var a, h, r = this.datasets.length - 1 ; r >= 0 && (a = this.datasets[r].points || this.datasets[r].bars || this.datasets[r].segments, h = l(a, t[0]), -1 === h) ; r--) ;
                    var c = [], u = [], d = function(){
                        var t, i, e, n, o, a = [], l = [], r = [];
                        return s.each(this.datasets, function(i){
                            t = i.points || i.bars || i.segments, t[h] && t[h].hasValue() && a.push(t[h])
                        }), s.each(a, function(t){
                            l.push(t.x), r.push(t.y), c.push(s.template(this.options.multiTooltipTemplate, t)), u.push({
                                fill  : t._saved.fillColor || t.fillColor,
                                stroke: t._saved.strokeColor || t.strokeColor
                            })
                        }, this), o = m(r), e = g(r), n = m(l), i = g(l), {
                            x: n > this.chart.width / 2? n : i,
                            y: (o + e) / 2
                        }
                    }.call(this, h);
                    new e.MultiTooltip({
                        x                    : d.x,
                        y                    : d.y,
                        xPadding             : this.options.tooltipXPadding,
                        yPadding             : this.options.tooltipYPadding,
                        xOffset              : this.options.tooltipXOffset,
                        fillColor            : this.options.tooltipFillColor,
                        textColor            : this.options.tooltipFontColor,
                        fontFamily           : this.options.tooltipFontFamily,
                        fontStyle            : this.options.tooltipFontStyle,
                        fontSize             : this.options.tooltipFontSize,
                        titleTextColor       : this.options.tooltipTitleFontColor,
                        titleFontFamily      : this.options.tooltipTitleFontFamily,
                        titleFontStyle       : this.options.tooltipTitleFontStyle,
                        titleFontSize        : this.options.tooltipTitleFontSize,
                        cornerRadius         : this.options.tooltipCornerRadius,
                        labels               : c,
                        legendColors         : u,
                        legendColorBackground: this.options.multiTooltipKeyBackground,
                        title                : t[0].label,
                        chart                : this.chart,
                        ctx                  : this.chart.ctx
                    }).draw()
                }
                else n(t, function(t){
                        var i = t.tooltipPosition();
                        new e.Tooltip({
                            x           : Math.round(i.x),
                            y           : Math.round(i.y),
                            xPadding    : this.options.tooltipXPadding,
                            yPadding    : this.options.tooltipYPadding,
                            fillColor   : this.options.tooltipFillColor,
                            textColor   : this.options.tooltipFontColor,
                            fontFamily  : this.options.tooltipFontFamily,
                            fontStyle   : this.options.tooltipFontStyle,
                            fontSize    : this.options.tooltipFontSize,
                            caretHeight : this.options.tooltipCaretSize,
                            cornerRadius: this.options.tooltipCornerRadius,
                            text        : C(this.options.tooltipTemplate, t),
                            chart       : this.chart
                        }).draw()
                    }, this);
                return this
            }
        }, toBase64Image : function(){
            return this.chart.canvas.toDataURL.apply(this.chart.canvas, arguments)
        }
    }), e.Type.extend = function(t){
        var i = this, s = function(){
            return i.apply(this, arguments)
        };
        if(s.prototype = o(i.prototype), a(s.prototype, t), s.extend = e.Type.extend, t.name || i.prototype.name)
        {
            var n = t.name || i.prototype.name, l = e.defaults[i.prototype.name]? o(e.defaults[i.prototype.name]) : {};
            e.defaults[n] = a(l, t.defaults), e.types[n] = s, e.prototype[n] = function(t, i){
                var o = h(e.defaults.global, e.defaults[n], i || {});
                return new s(t, o, this)
            }
        }
        else d("Name not provided for this chart, so it hasn't been registered");
        return i
    }, e.Element = function(t){
        a(this, t), this.initialize.apply(this, arguments), this.save()
    }, a(e.Element.prototype, {
        initialize        : function(){
        }, restore        : function(t){
            return t? n(t, function(t){
                this[t] = this._saved[t]
            }, this) : a(this, this._saved), this
        }, save           : function(){
            return this._saved = o(this), delete this._saved._saved, this
        }, update         : function(t){
            return n(t, function(t, i){
                this._saved[i] = this[i], this[i] = t
            }, this), this
        }, transition     : function(t, i){
            return n(t, function(t, e){
                this[e] = (t - this._saved[e]) * i + this._saved[e]
            }, this), this
        }, tooltipPosition: function(){
            return {x: this.x, y: this.y}
        }, hasValue       : function(){
            return f(this.value)
        }
    }), e.Element.extend = r, e.Point = e.Element.extend({
        display: !0, inRange: function(t, i){
            var e = this.hitDetectionRadius + this.radius;
            return Math.pow(t - this.x, 2) + Math.pow(i - this.y, 2) < Math.pow(e, 2)
        }, draw: function(){
            if(this.display)
            {
                var t = this.ctx;
                t.beginPath(), t.arc(this.x, this.y, this.radius, 0, 2 * Math.PI), t.closePath(), t.strokeStyle = this.strokeColor, t.lineWidth = this.strokeWidth, t.fillStyle = this.fillColor, t.fill(), t.stroke()
            }
        }
    }), e.Arc = e.Element.extend({
        inRange           : function(t, i){
            var e = s.getAngleFromPoint(this, {x: t, y: i}), n = e.angle >= this.startAngle && e.angle <= this.endAngle,
                o = e.distance >= this.innerRadius && e.distance <= this.outerRadius;
            return n && o
        }, tooltipPosition: function(){
            var t = this.startAngle + (this.endAngle - this.startAngle) / 2,
                i = (this.outerRadius - this.innerRadius) / 2 + this.innerRadius;
            return {x: this.x + Math.cos(t) * i, y: this.y + Math.sin(t) * i}
        }, draw           : function(t){
            var i = this.ctx;
            i.beginPath(), i.arc(this.x, this.y, this.outerRadius, this.startAngle, this.endAngle), i.arc(this.x, this.y, this.innerRadius, this.endAngle, this.startAngle, !0), i.closePath(), i.strokeStyle = this.strokeColor, i.lineWidth = this.strokeWidth, i.fillStyle = this.fillColor, i.fill(), i.lineJoin = "bevel", this.showStroke && i.stroke()
        }
    }), e.Rectangle = e.Element.extend({
        draw      : function(){
            var t = this.ctx, i = this.width / 2, e = this.x - i, s = this.x + i, n = this.base - (this.base - this.y),
                o = this.strokeWidth / 2;
            this.showStroke && (e += o, s -= o, n += o), t.beginPath(), t.fillStyle = this.fillColor, t.strokeStyle = this.strokeColor, t.lineWidth = this.strokeWidth, t.moveTo(e, this.base), t.lineTo(e, n), t.lineTo(s, n), t.lineTo(s, this.base), t.fill(), this.showStroke && t.stroke()
        }, height : function(){
            return this.base - this.y
        }, inRange: function(t, i){
            return t >= this.x - this.width / 2 && t <= this.x + this.width / 2 && i >= this.y && i <= this.base
        }
    }), e.Tooltip = e.Element.extend({
        draw: function(){
            var t = this.chart.ctx;
            t.font = M(this.fontSize, this.fontStyle, this.fontFamily), this.xAlign = "center", this.yAlign = "above";
            var i = 2, e = t.measureText(this.text).width + 2 * this.xPadding, s = this.fontSize + 2 * this.yPadding,
                n = s + this.caretHeight + i;
            this.x + e / 2 > this.chart.width? this.xAlign = "left" : this.x - e / 2 < 0 && (this.xAlign = "right"), this.y - n < 0 && (this.yAlign = "below");
            var o = this.x - e / 2, a = this.y - n;
            switch(t.fillStyle = this.fillColor, this.yAlign)
            {
                case"above":
                    t.beginPath(), t.moveTo(this.x, this.y - i), t.lineTo(this.x + this.caretHeight, this.y - (i + this.caretHeight)), t.lineTo(this.x - this.caretHeight, this.y - (i + this.caretHeight)), t.closePath(), t.fill();
                    break;
                case"below":
                    a = this.y + i + this.caretHeight, t.beginPath(), t.moveTo(this.x, this.y + i), t.lineTo(this.x + this.caretHeight, this.y + i + this.caretHeight), t.lineTo(this.x - this.caretHeight, this.y + i + this.caretHeight), t.closePath(), t.fill()
            }
            switch(this.xAlign)
            {
                case"left":
                    o = this.x - e + (this.cornerRadius + this.caretHeight);
                    break;
                case"right":
                    o = this.x - (this.cornerRadius + this.caretHeight)
            }
            z(t, o, a, e, s, this.cornerRadius), t.fill(), t.fillStyle = this.textColor, t.textAlign = "center", t.textBaseline = "middle", t.fillText(this.text, o + e / 2, a + s / 2)
        }
    }), e.MultiTooltip = e.Element.extend({
        initialize      : function(){
            this.font = M(this.fontSize, this.fontStyle, this.fontFamily), this.titleFont = M(this.titleFontSize, this.titleFontStyle, this.titleFontFamily), this.height = this.labels.length * this.fontSize + (this.labels.length - 1) * (this.fontSize / 2) + 2 * this.yPadding + 1.5 * this.titleFontSize, this.ctx.font = this.titleFont;
            var t = this.ctx.measureText(this.title).width, i = W(this.ctx, this.font, this.labels) + this.fontSize + 3,
                e = g([i, t]);
            this.width = e + 2 * this.xPadding;
            var s = this.height / 2;
            this.y - s < 0? this.y = s : this.y + s > this.chart.height && (this.y = this.chart.height - s), this.x > this.chart.width / 2? this.x -= this.xOffset + this.width : this.x += this.xOffset
        }, getLineHeight: function(t){
            var i = this.y - this.height / 2 + this.yPadding, e = t - 1;
            return 0 === t? i + this.titleFontSize / 2 : i + (1.5 * this.fontSize * e + this.fontSize / 2) + 1.5 * this.titleFontSize
        }, draw         : function(){
            z(this.ctx, this.x, this.y - this.height / 2, this.width, this.height, this.cornerRadius);
            var t = this.ctx;
            t.fillStyle = this.fillColor, t.fill(), t.closePath(), t.textAlign = "left", t.textBaseline = "middle", t.fillStyle = this.titleTextColor, t.font = this.titleFont, t.fillText(this.title, this.x + this.xPadding, this.getLineHeight(0)), t.font = this.font, s.each(this.labels, function(i, e){
                t.fillStyle = this.textColor, t.fillText(i, this.x + this.xPadding + this.fontSize + 3, this.getLineHeight(e + 1)), t.fillStyle = this.legendColorBackground, t.fillRect(this.x + this.xPadding, this.getLineHeight(e + 1) - this.fontSize / 2, this.fontSize, this.fontSize), t.fillStyle = this.legendColors[e].fill, t.fillRect(this.x + this.xPadding, this.getLineHeight(e + 1) - this.fontSize / 2, this.fontSize, this.fontSize)
            }, this)
        }
    }), e.Scale = e.Element.extend({
        initialize                : function(){
            this.fit()
        }, buildYLabels           : function(){
            this.yLabels = [];
            for(var t = v(this.stepValue), i = 0 ; i <= this.steps ; i++) this.yLabels.push(C(this.templateString, {value: (this.min + i * this.stepValue).toFixed(t)}));
            this.yLabelWidth = this.display && this.showLabels? W(this.ctx, this.font, this.yLabels) : 0
        }, addXLabel              : function(t){
            this.xLabels.push(t), this.valuesCount++, this.fit()
        }, removeXLabel           : function(){
            this.xLabels.shift(), this.valuesCount--, this.fit()
        }, fit                    : function(){
            this.startPoint = this.display? this.fontSize : 0, this.endPoint = this.display? this.height - 1.5 * this.fontSize - 5 : this.height, this.startPoint += this.padding, this.endPoint -= this.padding;
            var t, i = this.endPoint - this.startPoint;
            for(this.calculateYRange(i), this.buildYLabels(), this.calculateXLabelRotation() ; i > this.endPoint - this.startPoint ;) i = this.endPoint - this.startPoint, t = this.yLabelWidth, this.calculateYRange(i), this.buildYLabels(), t < this.yLabelWidth && this.calculateXLabelRotation()
        }, calculateXLabelRotation: function(){
            this.ctx.font = this.font;
            var t, i, e = this.ctx.measureText(this.xLabels[0]).width,
                s = this.ctx.measureText(this.xLabels[this.xLabels.length - 1]).width;
            if(this.xScalePaddingRight = s / 2 + 3, this.xScalePaddingLeft = e / 2 > this.yLabelWidth + 10? e / 2 : this.yLabelWidth + 10, this.xLabelRotation = 0, this.display)
            {
                var n, o = W(this.ctx, this.font, this.xLabels);
                this.xLabelWidth = o;
                for(var a = Math.floor(this.calculateX(1) - this.calculateX(0)) - 6 ; this.xLabelWidth > a && 0 === this.xLabelRotation || this.xLabelWidth > a && this.xLabelRotation <= 90 && this.xLabelRotation > 0 ;) n = Math.cos(x(this.xLabelRotation)), t = n * e, i = n * s, t + this.fontSize / 2 > this.yLabelWidth + 8 && (this.xScalePaddingLeft = t + this.fontSize / 2), this.xScalePaddingRight = this.fontSize / 2, this.xLabelRotation++, this.xLabelWidth = n * o;
                this.xLabelRotation > 0 && (this.endPoint -= Math.sin(x(this.xLabelRotation)) * o + 3)
            }
            else this.xLabelWidth = 0, this.xScalePaddingRight = this.padding, this.xScalePaddingLeft = this.padding
        }, calculateYRange        : c, drawingArea: function(){
            return this.startPoint - this.endPoint
        }, calculateY             : function(t){
            var i = this.drawingArea() / (this.min - this.max);
            return this.endPoint - i * (t - this.min)
        }, calculateX             : function(t){
            var i = (this.xLabelRotation > 0, this.width - (this.xScalePaddingLeft + this.xScalePaddingRight)),
                e = i / (this.valuesCount - (this.offsetGridLines? 0 : 1)), s = e * t + this.xScalePaddingLeft;
            return this.offsetGridLines && (s += e / 2), Math.round(s)
        }, update                 : function(t){
            s.extend(this, t), this.fit()
        }, draw                   : function(){
            var t = this.ctx, i = (this.endPoint - this.startPoint) / this.steps,
                e = Math.round(this.xScalePaddingLeft);
            this.display && (t.fillStyle = this.textColor, t.font = this.font, n(this.yLabels, function(n, o){
                var a = this.endPoint - i * o, h = Math.round(a);
                t.textAlign = "right", t.textBaseline = "middle", this.showLabels && t.fillText(n, e - 10, a), t.beginPath(), o > 0? (t.lineWidth = this.gridLineWidth, t.strokeStyle = this.gridLineColor) : (t.lineWidth = this.lineWidth, t.strokeStyle = this.lineColor), h += s.aliasPixel(t.lineWidth), t.moveTo(e, h), t.lineTo(this.width, h), t.stroke(), t.closePath(), t.lineWidth = this.lineWidth, t.strokeStyle = this.lineColor, t.beginPath(), t.moveTo(e - 5, h), t.lineTo(e, h), t.stroke(), t.closePath()
            }, this), n(this.xLabels, function(i, e){
                var s = this.calculateX(e) + S(this.lineWidth),
                    n = this.calculateX(e - (this.offsetGridLines? .5 : 0)) + S(this.lineWidth),
                    o = this.xLabelRotation > 0;
                t.beginPath(), e > 0? (t.lineWidth = this.gridLineWidth, t.strokeStyle = this.gridLineColor) : (t.lineWidth = this.lineWidth, t.strokeStyle = this.lineColor), t.moveTo(n, this.endPoint), t.lineTo(n, this.startPoint - 3), t.stroke(), t.closePath(), t.lineWidth = this.lineWidth, t.strokeStyle = this.lineColor, t.beginPath(), t.moveTo(n, this.endPoint), t.lineTo(n, this.endPoint + 5), t.stroke(), t.closePath(), t.save(), t.translate(s, o? this.endPoint + 12 : this.endPoint + 8), t.rotate(-1 * x(this.xLabelRotation)), t.font = this.font, t.textAlign = o? "right" : "center", t.textBaseline = o? "middle" : "top", t.fillText(i, 0, 0), t.restore()
            }, this))
        }
    }), e.RadialScale = e.Element.extend({
        initialize              : function(){
            this.size = m([this.height, this.width]), this.drawingArea = this.display? this.size / 2 - (this.fontSize / 2 + this.backdropPaddingY) : this.size / 2
        }, calculateCenterOffset: function(t){
            var i = this.drawingArea / (this.max - this.min);
            return (t - this.min) * i
        }, update               : function(){
            this.lineArc? this.drawingArea = this.display? this.size / 2 - (this.fontSize / 2 + this.backdropPaddingY) : this.size / 2 : this.setScaleSize(), this.buildYLabels()
        }, buildYLabels         : function(){
            this.yLabels = [];
            for(var t = v(this.stepValue), i = 0 ; i <= this.steps ; i++) this.yLabels.push(C(this.templateString, {value: (this.min + i * this.stepValue).toFixed(t)}))
        }, getCircumference     : function(){
            return 2 * Math.PI / this.valuesCount
        }, setScaleSize         : function(){
            var t, i, e, s, n, o, a, h, l, r, c, u,
                d = m([this.height / 2 - this.pointLabelFontSize - 5, this.width / 2]), p = this.width, g = 0;
            for(this.ctx.font = M(this.pointLabelFontSize, this.pointLabelFontStyle, this.pointLabelFontFamily), i = 0 ; i < this.valuesCount ; i++) t = this.getPointPosition(i, d), e = this.ctx.measureText(C(this.templateString, {value: this.labels[i]})).width + 5, 0 === i || i === this.valuesCount / 2? (s = e / 2, t.x + s > p && (p = t.x + s, n = i), t.x - s < g && (g = t.x - s, a = i)) : i < this.valuesCount / 2? t.x + e > p && (p = t.x + e, n = i) : i > this.valuesCount / 2 && t.x - e < g && (g = t.x - e, a = i);
            l = g, r = Math.ceil(p - this.width), o = this.getIndexAngle(n), h = this.getIndexAngle(a), c = r / Math.sin(o + Math.PI / 2), u = l / Math.sin(h + Math.PI / 2), c = f(c)? c : 0, u = f(u)? u : 0, this.drawingArea = d - (u + c) / 2, this.setCenterPoint(u, c)
        }, setCenterPoint       : function(t, i){
            var e = this.width - i - this.drawingArea, s = t + this.drawingArea;
            this.xCenter = (s + e) / 2, this.yCenter = this.height / 2
        }, getIndexAngle        : function(t){
            var i = 2 * Math.PI / this.valuesCount;
            return t * i - Math.PI / 2
        }, getPointPosition     : function(t, i){
            var e = this.getIndexAngle(t);
            return {x: Math.cos(e) * i + this.xCenter, y: Math.sin(e) * i + this.yCenter}
        }, draw                 : function(){
            if(this.display)
            {
                var t = this.ctx;
                if(n(this.yLabels, function(i, e){
                        if(e > 0)
                        {
                            var s, n = e * (this.drawingArea / this.steps), o = this.yCenter - n;
                            if(this.lineWidth > 0) if(t.strokeStyle = this.lineColor, t.lineWidth = this.lineWidth, this.lineArc) t.beginPath(), t.arc(this.xCenter, this.yCenter, n, 0, 2 * Math.PI), t.closePath(), t.stroke();
                            else
                            {
                                t.beginPath();
                                for(var a = 0 ; a < this.valuesCount ; a++) s = this.getPointPosition(a, this.calculateCenterOffset(this.min + e * this.stepValue)), 0 === a? t.moveTo(s.x, s.y) : t.lineTo(s.x, s.y);
                                t.closePath(), t.stroke()
                            }
                            if(this.showLabels)
                            {
                                if(t.font = M(this.fontSize, this.fontStyle, this.fontFamily), this.showLabelBackdrop)
                                {
                                    var h = t.measureText(i).width;
                                    t.fillStyle = this.backdropColor, t.fillRect(this.xCenter - h / 2 - this.backdropPaddingX, o - this.fontSize / 2 - this.backdropPaddingY, h + 2 * this.backdropPaddingX, this.fontSize + 2 * this.backdropPaddingY)
                                }
                                t.textAlign = "center", t.textBaseline = "middle", t.fillStyle = this.fontColor, t.fillText(i, this.xCenter, o)
                            }
                        }
                    }, this), !this.lineArc)
                {
                    t.lineWidth = this.angleLineWidth, t.strokeStyle = this.angleLineColor;
                    for(var i = this.valuesCount - 1 ; i >= 0 ; i--)
                    {
                        if(this.angleLineWidth > 0)
                        {
                            var e = this.getPointPosition(i, this.calculateCenterOffset(this.max));
                            t.beginPath(), t.moveTo(this.xCenter, this.yCenter), t.lineTo(e.x, e.y), t.stroke(), t.closePath()
                        }
                        var s = this.getPointPosition(i, this.calculateCenterOffset(this.max) + 5);
                        t.font = M(this.pointLabelFontSize, this.pointLabelFontStyle, this.pointLabelFontFamily), t.fillStyle = this.pointLabelFontColor;
                        var o = this.labels.length, a = this.labels.length / 2, h = a / 2, l = h > i || i > o - h,
                            r = i === h || i === o - h;
                        t.textAlign = 0 === i? "center" : i === a? "center" : a > i? "left" : "right", t.textBaseline = r? "middle" : l? "bottom" : "top", t.fillText(this.labels[i], s.x, s.y)
                    }
                }
            }
        }
    }), s.addEvent(window, "resize", function(){
        var t;
        return function(){
            clearTimeout(t), t = setTimeout(function(){
                n(e.instances, function(t){
                    t.options.responsive && t.resize(t.render, !0)
                })
            }, 50)
        }
    }()), p? define(function(){
        return e
    }) : "object" == typeof module && module.exports && (module.exports = e), t.Chart = e, e.noConflict = function(){
        return t.Chart = i, e
    }
}).call(this), function(){
    "use strict";
    var t = this, i = t.Chart, e = i.helpers, s = {
        scaleBeginAtZero  : !0,
        scaleShowGridLines: !0,
        scaleGridLineColor: "rgba(0,0,0,.05)",
        scaleGridLineWidth: 1,
        barShowStroke     : !0,
        barStrokeWidth    : 2,
        barValueSpacing   : 5,
        barDatasetSpacing : 1,
        legendTemplate    : '<ul class="<%=name.toLowerCase()%>-legend"><% for (var i=0; i<datasets.length; i++){%><li><span style="background-color:<%=datasets[i].fillColor%>"></span><%if(datasets[i].label){%><%=datasets[i].label%><%}%></li><%}%></ul>'
    };
    i.Type.extend({
        name             : "Bar", defaults: s, initialize: function(t){
            var s = this.options;
            this.ScaleClass = i.Scale.extend({
                offsetGridLines      : !0, calculateBarX: function(t, i, e){
                    var n = this.calculateBaseWidth(), o = this.calculateX(e) - n / 2, a = this.calculateBarWidth(t);
                    return o + a * i + i * s.barDatasetSpacing + a / 2
                }, calculateBaseWidth: function(){
                    return this.calculateX(1) - this.calculateX(0) - 2 * s.barValueSpacing
                }, calculateBarWidth : function(t){
                    var i = this.calculateBaseWidth() - (t - 1) * s.barDatasetSpacing;
                    return i / t
                }
            }), this.datasets = [], this.options.showTooltips && e.bindEvents(this, this.options.tooltipEvents, function(t){
                var i = "mouseout" !== t.type? this.getBarsAtEvent(t) : [];
                this.eachBars(function(t){
                    t.restore(["fillColor", "strokeColor"])
                }), e.each(i, function(t){
                    t.fillColor = t.highlightFill, t.strokeColor = t.highlightStroke
                }), this.showTooltip(i)
            }), this.BarClass = i.Rectangle.extend({
                strokeWidth: this.options.barStrokeWidth,
                showStroke : this.options.barShowStroke,
                ctx        : this.chart.ctx
            }), e.each(t.datasets, function(i){
                var s = {label: i.label || null, fillColor: i.fillColor, strokeColor: i.strokeColor, bars: []};
                this.datasets.push(s), e.each(i.data, function(e, n){
                    s.bars.push(new this.BarClass({
                        value          : e,
                        label          : t.labels[n],
                        datasetLabel   : i.label,
                        strokeColor    : i.strokeColor,
                        fillColor      : i.fillColor,
                        highlightFill  : i.highlightFill || i.fillColor,
                        highlightStroke: i.highlightStroke || i.strokeColor
                    }))
                }, this)
            }, this), this.buildScale(t.labels), this.BarClass.prototype.base = this.scale.endPoint, this.eachBars(function(t, i, s){
                e.extend(t, {
                    width: this.scale.calculateBarWidth(this.datasets.length),
                    x    : this.scale.calculateBarX(this.datasets.length, s, i),
                    y    : this.scale.endPoint
                }), t.save()
            }, this), this.render()
        }, update        : function(){
            this.scale.update(), e.each(this.activeElements, function(t){
                t.restore(["fillColor", "strokeColor"])
            }), this.eachBars(function(t){
                t.save()
            }), this.render()
        }, eachBars      : function(t){
            e.each(this.datasets, function(i, s){
                e.each(i.bars, t, this, s)
            }, this)
        }, getBarsAtEvent: function(t){
            for(var i, s = [], n = e.getRelativePosition(t), o = function(t){
                s.push(t.bars[i])
            }, a = 0 ; a < this.datasets.length ; a++) for(i = 0 ; i < this.datasets[a].bars.length ; i++) if(this.datasets[a].bars[i].inRange(n.x, n.y)) return e.each(this.datasets, o), s;
            return s
        }, buildScale    : function(t){
            var i = this, s = function(){
                var t = [];
                return i.eachBars(function(i){
                    t.push(i.value)
                }), t
            }, n = {
                templateString : this.options.scaleLabel,
                height         : this.chart.height,
                width          : this.chart.width,
                ctx            : this.chart.ctx,
                textColor      : this.options.scaleFontColor,
                fontSize       : this.options.scaleFontSize,
                fontStyle      : this.options.scaleFontStyle,
                fontFamily     : this.options.scaleFontFamily,
                valuesCount    : t.length,
                beginAtZero    : this.options.scaleBeginAtZero,
                integersOnly   : this.options.scaleIntegersOnly,
                calculateYRange: function(t){
                    var i = e.calculateScaleRange(s(), t, this.fontSize, this.beginAtZero, this.integersOnly);
                    e.extend(this, i)
                },
                xLabels        : t,
                font           : e.fontString(this.options.scaleFontSize, this.options.scaleFontStyle, this.options.scaleFontFamily),
                lineWidth      : this.options.scaleLineWidth,
                lineColor      : this.options.scaleLineColor,
                gridLineWidth  : this.options.scaleShowGridLines? this.options.scaleGridLineWidth : 0,
                gridLineColor  : this.options.scaleShowGridLines? this.options.scaleGridLineColor : "rgba(0,0,0,0)",
                padding        : this.options.showScale? 0 : this.options.barShowStroke? this.options.barStrokeWidth : 0,
                showLabels     : this.options.scaleShowLabels,
                display        : this.options.showScale
            };
            this.options.scaleOverride && e.extend(n, {
                calculateYRange: e.noop,
                steps          : this.options.scaleSteps,
                stepValue      : this.options.scaleStepWidth,
                min            : this.options.scaleStartValue,
                max            : this.options.scaleStartValue + this.options.scaleSteps * this.options.scaleStepWidth
            }), this.scale = new this.ScaleClass(n)
        }, addData       : function(t, i){
            e.each(t, function(t, e){
                this.datasets[e].bars.push(new this.BarClass({
                    value      : t,
                    label      : i,
                    x          : this.scale.calculateBarX(this.datasets.length, e, this.scale.valuesCount + 1),
                    y          : this.scale.endPoint,
                    width      : this.scale.calculateBarWidth(this.datasets.length),
                    base       : this.scale.endPoint,
                    strokeColor: this.datasets[e].strokeColor,
                    fillColor  : this.datasets[e].fillColor
                }))
            }, this), this.scale.addXLabel(i), this.update()
        }, removeData    : function(){
            this.scale.removeXLabel(), e.each(this.datasets, function(t){
                t.bars.shift()
            }, this), this.update()
        }, reflow        : function(){
            e.extend(this.BarClass.prototype, {y: this.scale.endPoint, base: this.scale.endPoint});
            var t = e.extend({height: this.chart.height, width: this.chart.width});
            this.scale.update(t)
        }, draw          : function(t){
            var i = t || 1;
            this.clear();
            this.chart.ctx;
            this.scale.draw(i), e.each(this.datasets, function(t, s){
                e.each(t.bars, function(t, e){
                    t.hasValue() && (t.base = this.scale.endPoint, t.transition({
                        x    : this.scale.calculateBarX(this.datasets.length, s, e),
                        y    : this.scale.calculateY(t.value),
                        width: this.scale.calculateBarWidth(this.datasets.length)
                    }, i).draw())
                }, this)
            }, this)
        }
    })
}.call(this), function(){
    "use strict";
    var t = this, i = t.Chart, e = i.helpers, s = {
        segmentShowStroke    : !0,
        segmentStrokeColor   : "#fff",
        segmentStrokeWidth   : 2,
        percentageInnerCutout: 50,
        animationSteps       : 100,
        animationEasing      : "easeOutBounce",
        animateRotate        : !0,
        animateScale         : !1,
        legendTemplate       : '<ul class="<%=name.toLowerCase()%>-legend"><% for (var i=0; i<segments.length; i++){%><li><span style="background-color:<%=segments[i].fillColor%>"></span><%if(segments[i].label){%><%=segments[i].label%><%}%></li><%}%></ul>'
    };
    i.Type.extend({
        name                     : "Doughnut", defaults: s, initialize: function(t){
            this.segments = [], this.outerRadius = (e.min([this.chart.width, this.chart.height]) - this.options.segmentStrokeWidth / 2) / 2, this.SegmentArc = i.Arc.extend({
                ctx: this.chart.ctx,
                x  : this.chart.width / 2,
                y  : this.chart.height / 2
            }), this.options.showTooltips && e.bindEvents(this, this.options.tooltipEvents, function(t){
                var i = "mouseout" !== t.type? this.getSegmentsAtEvent(t) : [];
                e.each(this.segments, function(t){
                    t.restore(["fillColor"])
                }), e.each(i, function(t){
                    t.fillColor = t.highlightColor
                }), this.showTooltip(i)
            }), this.calculateTotal(t), e.each(t, function(t, i){
                this.addData(t, i, !0)
            }, this), this.render()
        }, getSegmentsAtEvent    : function(t){
            var i = [], s = e.getRelativePosition(t);
            return e.each(this.segments, function(t){
                t.inRange(s.x, s.y) && i.push(t)
            }, this), i
        }, addData               : function(t, i, e){
            var s = i || this.segments.length;
            this.segments.splice(s, 0, new this.SegmentArc({
                value         : t.value,
                outerRadius   : this.options.animateScale? 0 : this.outerRadius,
                innerRadius   : this.options.animateScale? 0 : this.outerRadius / 100 * this.options.percentageInnerCutout,
                fillColor     : t.color,
                highlightColor: t.highlight || t.color,
                showStroke    : this.options.segmentShowStroke,
                strokeWidth   : this.options.segmentStrokeWidth,
                strokeColor   : this.options.segmentStrokeColor,
                startAngle    : 1.5 * Math.PI,
                circumference : this.options.animateRotate? 0 : this.calculateCircumference(t.value),
                label         : t.label
            })), e || (this.reflow(), this.update())
        }, calculateCircumference: function(t){
            return 2 * Math.PI * (t / this.total)
        }, calculateTotal        : function(t){
            this.total = 0, e.each(t, function(t){
                this.total += t.value
            }, this)
        }, update                : function(){
            this.calculateTotal(this.segments), e.each(this.activeElements, function(t){
                t.restore(["fillColor"])
            }), e.each(this.segments, function(t){
                t.save()
            }), this.render()
        }, removeData            : function(t){
            var i = e.isNumber(t)? t : this.segments.length - 1;
            this.segments.splice(i, 1), this.reflow(), this.update()
        }, reflow                : function(){
            e.extend(this.SegmentArc.prototype, {
                x: this.chart.width / 2,
                y: this.chart.height / 2
            }), this.outerRadius = (e.min([this.chart.width, this.chart.height]) - this.options.segmentStrokeWidth / 2) / 2, e.each(this.segments, function(t){
                t.update({
                    outerRadius: this.outerRadius,
                    innerRadius: this.outerRadius / 100 * this.options.percentageInnerCutout
                })
            }, this)
        }, draw                  : function(t){
            var i = t? t : 1;
            this.clear(), e.each(this.segments, function(t, e){
                t.transition({
                    circumference: this.calculateCircumference(t.value),
                    outerRadius  : this.outerRadius,
                    innerRadius  : this.outerRadius / 100 * this.options.percentageInnerCutout
                }, i), t.endAngle = t.startAngle + t.circumference, t.draw(), 0 === e && (t.startAngle = 1.5 * Math.PI), e < this.segments.length - 1 && (this.segments[e + 1].startAngle = t.endAngle)
            }, this)
        }
    }), i.types.Doughnut.extend({name: "Pie", defaults: e.merge(s, {percentageInnerCutout: 0})})
}.call(this), function(){
    "use strict";
    var t = this, i = t.Chart, e = i.helpers, s = {
        scaleShowGridLines     : !0,
        scaleGridLineColor     : "rgba(0,0,0,.05)",
        scaleGridLineWidth     : 1,
        bezierCurve            : !0,
        bezierCurveTension     : .4,
        pointDot               : !0,
        pointDotRadius         : 4,
        pointDotStrokeWidth    : 1,
        pointHitDetectionRadius: 20,
        datasetStroke          : !0,
        datasetStrokeWidth     : 2,
        datasetFill            : !0,
        legendTemplate         : '<ul class="<%=name.toLowerCase()%>-legend"><% for (var i=0; i<datasets.length; i++){%><li><span style="background-color:<%=datasets[i].strokeColor%>"></span><%if(datasets[i].label){%><%=datasets[i].label%><%}%></li><%}%></ul>'
    };
    i.Type.extend({
        name               : "Line", defaults: s, initialize: function(t){
            this.PointClass = i.Point.extend({
                strokeWidth       : this.options.pointDotStrokeWidth,
                radius            : this.options.pointDotRadius,
                display           : this.options.pointDot,
                hitDetectionRadius: this.options.pointHitDetectionRadius,
                ctx               : this.chart.ctx,
                inRange           : function(t){
                    return Math.pow(t - this.x, 2) < Math.pow(this.radius + this.hitDetectionRadius, 2)
                }
            }), this.datasets = [], this.options.showTooltips && e.bindEvents(this, this.options.tooltipEvents, function(t){
                var i = "mouseout" !== t.type? this.getPointsAtEvent(t) : [];
                this.eachPoints(function(t){
                    t.restore(["fillColor", "strokeColor"])
                }), e.each(i, function(t){
                    t.fillColor = t.highlightFill, t.strokeColor = t.highlightStroke
                }), this.showTooltip(i)
            }), e.each(t.datasets, function(i){
                var s = {
                    label           : i.label || null,
                    fillColor       : i.fillColor,
                    strokeColor     : i.strokeColor,
                    pointColor      : i.pointColor,
                    pointStrokeColor: i.pointStrokeColor,
                    points          : []
                };
                this.datasets.push(s), e.each(i.data, function(e, n){
                    s.points.push(new this.PointClass({
                        value          : e,
                        label          : t.labels[n],
                        datasetLabel   : i.label,
                        strokeColor    : i.pointStrokeColor,
                        fillColor      : i.pointColor,
                        highlightFill  : i.pointHighlightFill || i.pointColor,
                        highlightStroke: i.pointHighlightStroke || i.pointStrokeColor
                    }))
                }, this), this.buildScale(t.labels), this.eachPoints(function(t, i){
                    e.extend(t, {x: this.scale.calculateX(i), y: this.scale.endPoint}), t.save()
                }, this)
            }, this), this.render()
        }, update          : function(){
            this.scale.update(), e.each(this.activeElements, function(t){
                t.restore(["fillColor", "strokeColor"])
            }), this.eachPoints(function(t){
                t.save()
            }), this.render()
        }, eachPoints      : function(t){
            e.each(this.datasets, function(i){
                e.each(i.points, t, this)
            }, this)
        }, getPointsAtEvent: function(t){
            var i = [], s = e.getRelativePosition(t);
            return e.each(this.datasets, function(t){
                e.each(t.points, function(t){
                    t.inRange(s.x, s.y) && i.push(t)
                })
            }, this), i
        }, buildScale      : function(t){
            var s = this, n = function(){
                var t = [];
                return s.eachPoints(function(i){
                    t.push(i.value)
                }), t
            }, o = {
                templateString : this.options.scaleLabel,
                height         : this.chart.height,
                width          : this.chart.width,
                ctx            : this.chart.ctx,
                textColor      : this.options.scaleFontColor,
                fontSize       : this.options.scaleFontSize,
                fontStyle      : this.options.scaleFontStyle,
                fontFamily     : this.options.scaleFontFamily,
                valuesCount    : t.length,
                beginAtZero    : this.options.scaleBeginAtZero,
                integersOnly   : this.options.scaleIntegersOnly,
                calculateYRange: function(t){
                    var i = e.calculateScaleRange(n(), t, this.fontSize, this.beginAtZero, this.integersOnly);
                    e.extend(this, i)
                },
                xLabels        : t,
                font           : e.fontString(this.options.scaleFontSize, this.options.scaleFontStyle, this.options.scaleFontFamily),
                lineWidth      : this.options.scaleLineWidth,
                lineColor      : this.options.scaleLineColor,
                gridLineWidth  : this.options.scaleShowGridLines? this.options.scaleGridLineWidth : 0,
                gridLineColor  : this.options.scaleShowGridLines? this.options.scaleGridLineColor : "rgba(0,0,0,0)",
                padding        : this.options.showScale? 0 : this.options.pointDotRadius + this.options.pointDotStrokeWidth,
                showLabels     : this.options.scaleShowLabels,
                display        : this.options.showScale
            };
            this.options.scaleOverride && e.extend(o, {
                calculateYRange: e.noop,
                steps          : this.options.scaleSteps,
                stepValue      : this.options.scaleStepWidth,
                min            : this.options.scaleStartValue,
                max            : this.options.scaleStartValue + this.options.scaleSteps * this.options.scaleStepWidth
            }), this.scale = new i.Scale(o)
        }, addData         : function(t, i){
            e.each(t, function(t, e){
                this.datasets[e].points.push(new this.PointClass({
                    value      : t,
                    label      : i,
                    x          : this.scale.calculateX(this.scale.valuesCount + 1),
                    y          : this.scale.endPoint,
                    strokeColor: this.datasets[e].pointStrokeColor,
                    fillColor  : this.datasets[e].pointColor
                }))
            }, this), this.scale.addXLabel(i), this.update()
        }, removeData      : function(){
            this.scale.removeXLabel(), e.each(this.datasets, function(t){
                t.points.shift()
            }, this), this.update()
        }, reflow          : function(){
            var t = e.extend({height: this.chart.height, width: this.chart.width});
            this.scale.update(t)
        }, draw            : function(t){
            var i = t || 1;
            this.clear();
            var s = this.chart.ctx, n = function(t){
                return null !== t.value
            }, o = function(t, i, s){
                return e.findNextWhere(i, n, s) || t
            }, a = function(t, i, s){
                return e.findPreviousWhere(i, n, s) || t
            };
            this.scale.draw(i), e.each(this.datasets, function(t){
                var h = e.where(t.points, n);
                e.each(t.points, function(t, e){
                    t.hasValue() && t.transition({y: this.scale.calculateY(t.value), x: this.scale.calculateX(e)}, i)
                }, this), this.options.bezierCurve && e.each(h, function(t, i){
                    var s = i > 0 && i < h.length - 1? this.options.bezierCurveTension : 0;
                    t.controlPoints = e.splineCurve(a(t, h, i), t, o(t, h, i), s), t.controlPoints.outer.y > this.scale.endPoint? t.controlPoints.outer.y = this.scale.endPoint : t.controlPoints.outer.y < this.scale.startPoint && (t.controlPoints.outer.y = this.scale.startPoint), t.controlPoints.inner.y > this.scale.endPoint? t.controlPoints.inner.y = this.scale.endPoint : t.controlPoints.inner.y < this.scale.startPoint && (t.controlPoints.inner.y = this.scale.startPoint)
                }, this), s.lineWidth = this.options.datasetStrokeWidth, s.strokeStyle = t.strokeColor, s.beginPath(), e.each(h, function(t, i){
                    if(0 === i) s.moveTo(t.x, t.y);
                    else if(this.options.bezierCurve)
                    {
                        var e = a(t, h, i);
                        s.bezierCurveTo(e.controlPoints.outer.x, e.controlPoints.outer.y, t.controlPoints.inner.x, t.controlPoints.inner.y, t.x, t.y)
                    }
                    else s.lineTo(t.x, t.y)
                }, this), s.stroke(), this.options.datasetFill && h.length > 0 && (s.lineTo(h[h.length - 1].x, this.scale.endPoint), s.lineTo(h[0].x, this.scale.endPoint), s.fillStyle = t.fillColor, s.closePath(), s.fill()), e.each(h, function(t){
                    t.draw()
                })
            }, this)
        }
    })
}.call(this), function(){
    "use strict";
    var t = this, i = t.Chart, e = i.helpers, s = {
        scaleShowLabelBackdrop: !0,
        scaleBackdropColor    : "rgba(255,255,255,0.75)",
        scaleBeginAtZero      : !0,
        scaleBackdropPaddingY : 2,
        scaleBackdropPaddingX : 2,
        scaleShowLine         : !0,
        segmentShowStroke     : !0,
        segmentStrokeColor    : "#fff",
        segmentStrokeWidth    : 2,
        animationSteps        : 100,
        animationEasing       : "easeOutBounce",
        animateRotate         : !0,
        animateScale          : !1,
        legendTemplate        : '<ul class="<%=name.toLowerCase()%>-legend"><% for (var i=0; i<segments.length; i++){%><li><span style="background-color:<%=segments[i].fillColor%>"></span><%if(segments[i].label){%><%=segments[i].label%><%}%></li><%}%></ul>'
    };
    i.Type.extend({
        name                 : "PolarArea", defaults: s, initialize: function(t){
            this.segments = [], this.SegmentArc = i.Arc.extend({
                showStroke : this.options.segmentShowStroke,
                strokeWidth: this.options.segmentStrokeWidth,
                strokeColor: this.options.segmentStrokeColor,
                ctx        : this.chart.ctx,
                innerRadius: 0,
                x          : this.chart.width / 2,
                y          : this.chart.height / 2
            }), this.scale = new i.RadialScale({
                display          : this.options.showScale,
                fontStyle        : this.options.scaleFontStyle,
                fontSize         : this.options.scaleFontSize,
                fontFamily       : this.options.scaleFontFamily,
                fontColor        : this.options.scaleFontColor,
                showLabels       : this.options.scaleShowLabels,
                showLabelBackdrop: this.options.scaleShowLabelBackdrop,
                backdropColor    : this.options.scaleBackdropColor,
                backdropPaddingY : this.options.scaleBackdropPaddingY,
                backdropPaddingX : this.options.scaleBackdropPaddingX,
                lineWidth        : this.options.scaleShowLine? this.options.scaleLineWidth : 0,
                lineColor        : this.options.scaleLineColor,
                lineArc          : !0,
                width            : this.chart.width,
                height           : this.chart.height,
                xCenter          : this.chart.width / 2,
                yCenter          : this.chart.height / 2,
                ctx              : this.chart.ctx,
                templateString   : this.options.scaleLabel,
                valuesCount      : t.length
            }), this.updateScaleRange(t), this.scale.update(), e.each(t, function(t, i){
                this.addData(t, i, !0)
            }, this), this.options.showTooltips && e.bindEvents(this, this.options.tooltipEvents, function(t){
                var i = "mouseout" !== t.type? this.getSegmentsAtEvent(t) : [];
                e.each(this.segments, function(t){
                    t.restore(["fillColor"])
                }), e.each(i, function(t){
                    t.fillColor = t.highlightColor
                }), this.showTooltip(i)
            }), this.render()
        }, getSegmentsAtEvent: function(t){
            var i = [], s = e.getRelativePosition(t);
            return e.each(this.segments, function(t){
                t.inRange(s.x, s.y) && i.push(t)
            }, this), i
        }, addData           : function(t, i, e){
            var s = i || this.segments.length;
            this.segments.splice(s, 0, new this.SegmentArc({
                fillColor     : t.color,
                highlightColor: t.highlight || t.color,
                label         : t.label,
                value         : t.value,
                outerRadius   : this.options.animateScale? 0 : this.scale.calculateCenterOffset(t.value),
                circumference : this.options.animateRotate? 0 : this.scale.getCircumference(),
                startAngle    : 1.5 * Math.PI
            })), e || (this.reflow(), this.update())
        }, removeData        : function(t){
            var i = e.isNumber(t)? t : this.segments.length - 1;
            this.segments.splice(i, 1), this.reflow(), this.update()
        }, calculateTotal    : function(t){
            this.total = 0, e.each(t, function(t){
                this.total += t.value
            }, this), this.scale.valuesCount = this.segments.length
        }, updateScaleRange  : function(t){
            var i = [];
            e.each(t, function(t){
                i.push(t.value)
            });
            var s = this.options.scaleOverride? {
                steps    : this.options.scaleSteps,
                stepValue: this.options.scaleStepWidth,
                min      : this.options.scaleStartValue,
                max      : this.options.scaleStartValue + this.options.scaleSteps * this.options.scaleStepWidth
            } : e.calculateScaleRange(i, e.min([this.chart.width, this.chart.height]) / 2, this.options.scaleFontSize, this.options.scaleBeginAtZero, this.options.scaleIntegersOnly);
            e.extend(this.scale, s, {
                size   : e.min([this.chart.width, this.chart.height]),
                xCenter: this.chart.width / 2,
                yCenter: this.chart.height / 2
            })
        }, update            : function(){
            this.calculateTotal(this.segments), e.each(this.segments, function(t){
                t.save()
            }), this.render()
        }, reflow            : function(){
            e.extend(this.SegmentArc.prototype, {
                x: this.chart.width / 2,
                y: this.chart.height / 2
            }), this.updateScaleRange(this.segments), this.scale.update(), e.extend(this.scale, {
                xCenter: this.chart.width / 2,
                yCenter: this.chart.height / 2
            }), e.each(this.segments, function(t){
                t.update({outerRadius: this.scale.calculateCenterOffset(t.value)})
            }, this)
        }, draw              : function(t){
            var i = t || 1;
            this.clear(), e.each(this.segments, function(t, e){
                t.transition({
                    circumference: this.scale.getCircumference(),
                    outerRadius  : this.scale.calculateCenterOffset(t.value)
                }, i), t.endAngle = t.startAngle + t.circumference, 0 === e && (t.startAngle = 1.5 * Math.PI), e < this.segments.length - 1 && (this.segments[e + 1].startAngle = t.endAngle), t.draw()
            }, this), this.scale.draw()
        }
    })
}.call(this), function(){
    "use strict";
    var t = this, i = t.Chart, e = i.helpers;
    i.Type.extend({
        name            : "Radar",
        defaults        : {
            scaleShowLine          : !0,
            angleShowLineOut       : !0,
            scaleShowLabels        : !1,
            scaleBeginAtZero       : !0,
            angleLineColor         : "rgba(0,0,0,.1)",
            angleLineWidth         : 1,
            pointLabelFontFamily   : "'Arial'",
            pointLabelFontStyle    : "normal",
            pointLabelFontSize     : 10,
            pointLabelFontColor    : "#666",
            pointDot               : !0,
            pointDotRadius         : 3,
            pointDotStrokeWidth    : 1,
            pointHitDetectionRadius: 20,
            datasetStroke          : !0,
            datasetStrokeWidth     : 2,
            datasetFill            : !0,
            legendTemplate         : '<ul class="<%=name.toLowerCase()%>-legend"><% for (var i=0; i<datasets.length; i++){%><li><span style="background-color:<%=datasets[i].strokeColor%>"></span><%if(datasets[i].label){%><%=datasets[i].label%><%}%></li><%}%></ul>'
        },
        initialize      : function(t){
            this.PointClass = i.Point.extend({
                strokeWidth       : this.options.pointDotStrokeWidth,
                radius            : this.options.pointDotRadius,
                display           : this.options.pointDot,
                hitDetectionRadius: this.options.pointHitDetectionRadius,
                ctx               : this.chart.ctx
            }), this.datasets = [], this.buildScale(t), this.options.showTooltips && e.bindEvents(this, this.options.tooltipEvents, function(t){
                var i = "mouseout" !== t.type? this.getPointsAtEvent(t) : [];
                this.eachPoints(function(t){
                    t.restore(["fillColor", "strokeColor"])
                }), e.each(i, function(t){
                    t.fillColor = t.highlightFill, t.strokeColor = t.highlightStroke
                }), this.showTooltip(i)
            }), e.each(t.datasets, function(i){
                var s = {
                    label           : i.label || null,
                    fillColor       : i.fillColor,
                    strokeColor     : i.strokeColor,
                    pointColor      : i.pointColor,
                    pointStrokeColor: i.pointStrokeColor,
                    points          : []
                };
                this.datasets.push(s), e.each(i.data, function(e, n){
                    var o;
                    this.scale.animation || (o = this.scale.getPointPosition(n, this.scale.calculateCenterOffset(e))), s.points.push(new this.PointClass({
                        value          : e,
                        label          : t.labels[n],
                        datasetLabel   : i.label,
                        x              : this.options.animation? this.scale.xCenter : o.x,
                        y              : this.options.animation? this.scale.yCenter : o.y,
                        strokeColor    : i.pointStrokeColor,
                        fillColor      : i.pointColor,
                        highlightFill  : i.pointHighlightFill || i.pointColor,
                        highlightStroke: i.pointHighlightStroke || i.pointStrokeColor
                    }))
                }, this)
            }, this), this.render()
        },
        eachPoints      : function(t){
            e.each(this.datasets, function(i){
                e.each(i.points, t, this)
            }, this)
        },
        getPointsAtEvent: function(t){
            var i = e.getRelativePosition(t),
                s = e.getAngleFromPoint({x: this.scale.xCenter, y: this.scale.yCenter}, i),
                n = 2 * Math.PI / this.scale.valuesCount, o = Math.round((s.angle - 1.5 * Math.PI) / n), a = [];
            return (o >= this.scale.valuesCount || 0 > o) && (o = 0), s.distance <= this.scale.drawingArea && e.each(this.datasets, function(t){
                a.push(t.points[o])
            }), a
        },
        buildScale      : function(t){
            this.scale = new i.RadialScale({
                display             : this.options.showScale,
                fontStyle           : this.options.scaleFontStyle,
                fontSize            : this.options.scaleFontSize,
                fontFamily          : this.options.scaleFontFamily,
                fontColor           : this.options.scaleFontColor,
                showLabels          : this.options.scaleShowLabels,
                showLabelBackdrop   : this.options.scaleShowLabelBackdrop,
                backdropColor       : this.options.scaleBackdropColor,
                backdropPaddingY    : this.options.scaleBackdropPaddingY,
                backdropPaddingX    : this.options.scaleBackdropPaddingX,
                lineWidth           : this.options.scaleShowLine? this.options.scaleLineWidth : 0,
                lineColor           : this.options.scaleLineColor,
                angleLineColor      : this.options.angleLineColor,
                angleLineWidth      : this.options.angleShowLineOut? this.options.angleLineWidth : 0,
                pointLabelFontColor : this.options.pointLabelFontColor,
                pointLabelFontSize  : this.options.pointLabelFontSize,
                pointLabelFontFamily: this.options.pointLabelFontFamily,
                pointLabelFontStyle : this.options.pointLabelFontStyle,
                height              : this.chart.height,
                width               : this.chart.width,
                xCenter             : this.chart.width / 2,
                yCenter             : this.chart.height / 2,
                ctx                 : this.chart.ctx,
                templateString      : this.options.scaleLabel,
                labels              : t.labels,
                valuesCount         : t.datasets[0].data.length
            }), this.scale.setScaleSize(), this.updateScaleRange(t.datasets), this.scale.buildYLabels()
        },
        updateScaleRange: function(t){
            var i = function(){
                var i = [];
                return e.each(t, function(t){
                    t.data? i = i.concat(t.data) : e.each(t.points, function(t){
                        i.push(t.value)
                    })
                }), i
            }(), s = this.options.scaleOverride? {
                steps    : this.options.scaleSteps,
                stepValue: this.options.scaleStepWidth,
                min      : this.options.scaleStartValue,
                max      : this.options.scaleStartValue + this.options.scaleSteps * this.options.scaleStepWidth
            } : e.calculateScaleRange(i, e.min([this.chart.width, this.chart.height]) / 2, this.options.scaleFontSize, this.options.scaleBeginAtZero, this.options.scaleIntegersOnly);
            e.extend(this.scale, s)
        },
        addData         : function(t, i){
            this.scale.valuesCount++, e.each(t, function(t, e){
                var s = this.scale.getPointPosition(this.scale.valuesCount, this.scale.calculateCenterOffset(t));
                this.datasets[e].points.push(new this.PointClass({
                    value      : t,
                    label      : i,
                    x          : s.x,
                    y          : s.y,
                    strokeColor: this.datasets[e].pointStrokeColor,
                    fillColor  : this.datasets[e].pointColor
                }))
            }, this), this.scale.labels.push(i), this.reflow(), this.update()
        },
        removeData      : function(){
            this.scale.valuesCount--, this.scale.labels.shift(), e.each(this.datasets, function(t){
                t.points.shift()
            }, this), this.reflow(), this.update()
        },
        update          : function(){
            this.eachPoints(function(t){
                t.save()
            }), this.reflow(), this.render()
        },
        reflow          : function(){
            e.extend(this.scale, {
                width  : this.chart.width,
                height : this.chart.height,
                size   : e.min([this.chart.width, this.chart.height]),
                xCenter: this.chart.width / 2,
                yCenter: this.chart.height / 2
            }), this.updateScaleRange(this.datasets), this.scale.setScaleSize(), this.scale.buildYLabels()
        },
        draw            : function(t){
            var i = t || 1, s = this.chart.ctx;
            this.clear(), this.scale.draw(), e.each(this.datasets, function(t){
                e.each(t.points, function(t, e){
                    t.hasValue() && t.transition(this.scale.getPointPosition(e, this.scale.calculateCenterOffset(t.value)), i)
                }, this), s.lineWidth = this.options.datasetStrokeWidth, s.strokeStyle = t.strokeColor, s.beginPath(), e.each(t.points, function(t, i){
                    0 === i? s.moveTo(t.x, t.y) : s.lineTo(t.x, t.y)
                }, this), s.closePath(), s.stroke(), s.fillStyle = t.fillColor, s.fill(), e.each(t.points, function(t){
                    t.hasValue() && t.draw()
                })
            }, this)
        }
    })
}.call(this);

//! moment.js
//! version : 2.9.0
//! authors : Tim Wood, Iskren Chernev, Moment.js contributors
//! license : MIT
//! momentjs.com
var ender;
var global;
var require;
(function(a){
    function b(a, b, c)
    {
        switch(arguments.length)
        {
            case 2:
                return null != a? a : b;
            case 3:
                return null != a? a : null != b? b : c;
            default:
                throw new Error("Implement me")
        }
    }

    function c(a, b)
    {
        return Bb.call(a, b)
    }

    function d()
    {
        return {
            empty          : !1,
            unusedTokens   : [],
            unusedInput    : [],
            overflow       : -2,
            charsLeftOver  : 0,
            nullInput      : !1,
            invalidMonth   : null,
            invalidFormat  : !1,
            userInvalidated: !1,
            iso            : !1
        }
    }

    function e(a)
    {
        vb.suppressDeprecationWarnings === !1 && "undefined" != typeof console && console.warn && console.warn("Deprecation warning: " + a)
    }

    function f(a, b)
    {
        var c = !0;
        return o(function(){
            return c && (e(a), c = !1), b.apply(this, arguments)
        }, b)
    }

    function g(a, b)
    {
        sc[a] || (e(b), sc[a] = !0)
    }

    function h(a, b)
    {
        return function(c){
            return r(a.call(this, c), b)
        }
    }

    function i(a, b)
    {
        return function(c){
            return this.localeData().ordinal(a.call(this, c), b)
        }
    }

    function j(a, b)
    {
        var c, d, e = 12 * (b.year() - a.year()) + (b.month() - a.month()), f = a.clone().add(e, "months");
        return 0 > b - f? (c = a.clone().add(e - 1, "months"), d = (b - f) / (f - c)) : (c = a.clone().add(e + 1, "months"), d = (b - f) / (c - f)), -(e + d)
    }

    function k(a, b, c)
    {
        var d;
        return null == c? b : null != a.meridiemHour? a.meridiemHour(b, c) : null != a.isPM? (d = a.isPM(c), d && 12 > b && (b += 12), d || 12 !== b || (b = 0), b) : b
    }

    function l()
    {
    }

    function m(a, b)
    {
        b !== !1 && H(a), p(this, a), this._d = new Date(+a._d), uc === !1 && (uc = !0, vb.updateOffset(this), uc = !1)
    }

    function n(a)
    {
        var b = A(a), c = b.year || 0, d = b.quarter || 0, e = b.month || 0, f = b.week || 0, g = b.day || 0,
            h = b.hour || 0, i = b.minute || 0, j = b.second || 0, k = b.millisecond || 0;
        this._milliseconds = +k + 1e3 * j + 6e4 * i + 36e5 * h, this._days = +g + 7 * f, this._months = +e + 3 * d + 12 * c, this._data = {}, this._locale = vb.localeData(), this._bubble()
    }

    function o(a, b)
    {
        for(var d in b) c(b, d) && (a[d] = b[d]);
        return c(b, "toString") && (a.toString = b.toString), c(b, "valueOf") && (a.valueOf = b.valueOf), a
    }

    function p(a, b)
    {
        var c, d, e;
        if("undefined" != typeof b._isAMomentObject && (a._isAMomentObject = b._isAMomentObject), "undefined" != typeof b._i && (a._i = b._i), "undefined" != typeof b._f && (a._f = b._f), "undefined" != typeof b._l && (a._l = b._l), "undefined" != typeof b._strict && (a._strict = b._strict), "undefined" != typeof b._tzm && (a._tzm = b._tzm), "undefined" != typeof b._isUTC && (a._isUTC = b._isUTC), "undefined" != typeof b._offset && (a._offset = b._offset), "undefined" != typeof b._pf && (a._pf = b._pf), "undefined" != typeof b._locale && (a._locale = b._locale), Kb.length > 0) for(c in Kb) d = Kb[c], e = b[d], "undefined" != typeof e && (a[d] = e);
        return a
    }

    function q(a)
    {
        return 0 > a? Math.ceil(a) : Math.floor(a)
    }

    function r(a, b, c)
    {
        for(var d = "" + Math.abs(a), e = a >= 0 ; d.length < b ;) d = "0" + d;
        return (e? c? "+" : "" : "-") + d
    }

    function s(a, b)
    {
        var c = {milliseconds: 0, months: 0};
        return c.months = b.month() - a.month() + 12 * (b.year() - a.year()), a.clone().add(c.months, "M").isAfter(b) && --c.months, c.milliseconds = +b - +a.clone().add(c.months, "M"), c
    }

    function t(a, b)
    {
        var c;
        return b = M(b, a), a.isBefore(b)? c = s(a, b) : (c = s(b, a), c.milliseconds = -c.milliseconds, c.months = -c.months), c
    }

    function u(a, b)
    {
        return function(c, d){
            var e, f;
            return null === d || isNaN(+d) || (g(b, "moment()." + b + "(period, number) is deprecated. Please use moment()." + b + "(number, period)."), f = c, c = d, d = f), c = "string" == typeof c? +c : c, e = vb.duration(c, d), v(this, e, a), this
        }
    }

    function v(a, b, c, d)
    {
        var e = b._milliseconds, f = b._days, g = b._months;
        d = null == d? !0 : d, e && a._d.setTime(+a._d + e * c), f && pb(a, "Date", ob(a, "Date") + f * c), g && nb(a, ob(a, "Month") + g * c), d && vb.updateOffset(a, f || g)
    }

    function w(a)
    {
        return "[object Array]" === Object.prototype.toString.call(a)
    }

    function x(a)
    {
        return "[object Date]" === Object.prototype.toString.call(a) || a instanceof Date
    }

    function y(a, b, c)
    {
        var d, e = Math.min(a.length, b.length), f = Math.abs(a.length - b.length), g = 0;
        for(d = 0 ; e > d ; d++) (c && a[d] !== b[d] || !c && C(a[d]) !== C(b[d])) && g++;
        return g + f
    }

    function z(a)
    {
        if(a)
        {
            var b = a.toLowerCase().replace(/(.)s$/, "$1");
            a = lc[a] || mc[b] || b
        }
        return a
    }

    function A(a)
    {
        var b, d, e = {};
        for(d in a) c(a, d) && (b = z(d), b && (e[b] = a[d]));
        return e
    }

    function B(b)
    {
        var c, d;
        if(0 === b.indexOf("week")) c = 7, d = "day";
        else
        {
            if(0 !== b.indexOf("month")) return;
            c = 12, d = "month"
        }
        vb[b] = function(e, f){
            var g, h, i = vb._locale[b], j = [];
            if("number" == typeof e && (f = e, e = a), h = function(a){
                    var b = vb().utc().set(d, a);
                    return i.call(vb._locale, b, e || "")
                }, null != f) return h(f);
            for(g = 0 ; c > g ; g++) j.push(h(g));
            return j
        }
    }

    function C(a)
    {
        var b = +a, c = 0;
        return 0 !== b && isFinite(b) && (c = b >= 0? Math.floor(b) : Math.ceil(b)), c
    }

    function D(a, b)
    {
        return new Date(Date.UTC(a, b + 1, 0)).getUTCDate()
    }

    function E(a, b, c)
    {
        return jb(vb([a, 11, 31 + b - c]), b, c).week
    }

    function F(a)
    {
        return G(a)? 366 : 365
    }

    function G(a)
    {
        return a % 4 === 0 && a % 100 !== 0 || a % 400 === 0
    }

    function H(a)
    {
        var b;
        a._a && -2 === a._pf.overflow && (b = a._a[Db] < 0 || a._a[Db] > 11? Db : a._a[Eb] < 1 || a._a[Eb] > D(a._a[Cb], a._a[Db])? Eb : a._a[Fb] < 0 || a._a[Fb] > 24 || 24 === a._a[Fb] && (0 !== a._a[Gb] || 0 !== a._a[Hb] || 0 !== a._a[Ib])? Fb : a._a[Gb] < 0 || a._a[Gb] > 59? Gb : a._a[Hb] < 0 || a._a[Hb] > 59? Hb : a._a[Ib] < 0 || a._a[Ib] > 999? Ib : -1, a._pf._overflowDayOfYear && (Cb > b || b > Eb) && (b = Eb), a._pf.overflow = b)
    }

    function I(b)
    {
        return null == b._isValid && (b._isValid = !isNaN(b._d.getTime()) && b._pf.overflow < 0 && !b._pf.empty && !b._pf.invalidMonth && !b._pf.nullInput && !b._pf.invalidFormat && !b._pf.userInvalidated, b._strict && (b._isValid = b._isValid && 0 === b._pf.charsLeftOver && 0 === b._pf.unusedTokens.length && b._pf.bigHour === a)), b._isValid
    }

    function J(a)
    {
        return a? a.toLowerCase().replace("_", "-") : a
    }

    function K(a)
    {
        for(var b, c, d, e, f = 0 ; f < a.length ;)
        {
            for(e = J(a[f]).split("-"), b = e.length, c = J(a[f + 1]), c = c? c.split("-") : null ; b > 0 ;)
            {
                if(d = L(e.slice(0, b).join("-"))) return d;
                if(c && c.length >= b && y(e, c, !0) >= b - 1) break;
                b--
            }
            f++
        }
        return null
    }

    function L(a)
    {
        var b = null;
        if(!Jb[a] && Lb) try
        {
            b = vb.locale(), require("./locale/" + a), vb.locale(b)
        }
        catch(c)
        {
        }
        return Jb[a]
    }

    function M(a, b)
    {
        var c, d;
        return b._isUTC? (c = b.clone(), d = (vb.isMoment(a) || x(a)? +a : +vb(a)) - +c, c._d.setTime(+c._d + d), vb.updateOffset(c, !1), c) : vb(a).local()
    }

    function N(a)
    {
        return a.match(/\[[\s\S]/)? a.replace(/^\[|\]$/g, "") : a.replace(/\\/g, "")
    }

    function O(a)
    {
        var b, c, d = a.match(Pb);
        for(b = 0, c = d.length ; c > b ; b++) d[b] = rc[d[b]]? rc[d[b]] : N(d[b]);
        return function(e){
            var f = "";
            for(b = 0 ; c > b ; b++) f += d[b] instanceof Function? d[b].call(e, a) : d[b];
            return f
        }
    }

    function P(a, b)
    {
        return a.isValid()? (b = Q(b, a.localeData()), nc[b] || (nc[b] = O(b)), nc[b](a)) : a.localeData().invalidDate()
    }

    function Q(a, b)
    {
        function c(a)
        {
            return b.longDateFormat(a) || a
        }

        var d = 5;
        for(Qb.lastIndex = 0 ; d >= 0 && Qb.test(a) ;) a = a.replace(Qb, c), Qb.lastIndex = 0, d -= 1;
        return a
    }

    function R(a, b)
    {
        var c, d = b._strict;
        switch(a)
        {
            case"Q":
                return _b;
            case"DDDD":
                return bc;
            case"YYYY":
            case"GGGG":
            case"gggg":
                return d? cc : Tb;
            case"Y":
            case"G":
            case"g":
                return ec;
            case"YYYYYY":
            case"YYYYY":
            case"GGGGG":
            case"ggggg":
                return d? dc : Ub;
            case"S":
                if(d) return _b;
            case"SS":
                if(d) return ac;
            case"SSS":
                if(d) return bc;
            case"DDD":
                return Sb;
            case"MMM":
            case"MMMM":
            case"dd":
            case"ddd":
            case"dddd":
                return Wb;
            case"a":
            case"A":
                return b._locale._meridiemParse;
            case"x":
                return Zb;
            case"X":
                return $b;
            case"Z":
            case"ZZ":
                return Xb;
            case"T":
                return Yb;
            case"SSSS":
                return Vb;
            case"MM":
            case"DD":
            case"YY":
            case"GG":
            case"gg":
            case"HH":
            case"hh":
            case"mm":
            case"ss":
            case"ww":
            case"WW":
                return d? ac : Rb;
            case"M":
            case"D":
            case"d":
            case"H":
            case"h":
            case"m":
            case"s":
            case"w":
            case"W":
            case"e":
            case"E":
                return Rb;
            case"Do":
                return d? b._locale._ordinalParse : b._locale._ordinalParseLenient;
            default:
                return c = new RegExp($(Z(a.replace("\\", "")), "i"))
        }
    }

    function S(a)
    {
        a = a || "";
        var b = a.match(Xb) || [], c = b[b.length - 1] || [], d = (c + "").match(jc) || ["-", 0, 0],
            e = +(60 * d[1]) + C(d[2]);
        return "+" === d[0]? e : -e
    }

    function T(a, b, c)
    {
        var d, e = c._a;
        switch(a)
        {
            case"Q":
                null != b && (e[Db] = 3 * (C(b) - 1));
                break;
            case"M":
            case"MM":
                null != b && (e[Db] = C(b) - 1);
                break;
            case"MMM":
            case"MMMM":
                d = c._locale.monthsParse(b, a, c._strict), null != d? e[Db] = d : c._pf.invalidMonth = b;
                break;
            case"D":
            case"DD":
                null != b && (e[Eb] = C(b));
                break;
            case"Do":
                null != b && (e[Eb] = C(parseInt(b.match(/\d{1,2}/)[0], 10)));
                break;
            case"DDD":
            case"DDDD":
                null != b && (c._dayOfYear = C(b));
                break;
            case"YY":
                e[Cb] = vb.parseTwoDigitYear(b);
                break;
            case"YYYY":
            case"YYYYY":
            case"YYYYYY":
                e[Cb] = C(b);
                break;
            case"a":
            case"A":
                c._meridiem = b;
                break;
            case"h":
            case"hh":
                c._pf.bigHour = !0;
            case"H":
            case"HH":
                e[Fb] = C(b);
                break;
            case"m":
            case"mm":
                e[Gb] = C(b);
                break;
            case"s":
            case"ss":
                e[Hb] = C(b);
                break;
            case"S":
            case"SS":
            case"SSS":
            case"SSSS":
                e[Ib] = C(1e3 * ("0." + b));
                break;
            case"x":
                c._d = new Date(C(b));
                break;
            case"X":
                c._d = new Date(1e3 * parseFloat(b));
                break;
            case"Z":
            case"ZZ":
                c._useUTC = !0, c._tzm = S(b);
                break;
            case"dd":
            case"ddd":
            case"dddd":
                d = c._locale.weekdaysParse(b), null != d? (c._w = c._w || {}, c._w.d = d) : c._pf.invalidWeekday = b;
                break;
            case"w":
            case"ww":
            case"W":
            case"WW":
            case"d":
            case"e":
            case"E":
                a = a.substr(0, 1);
            case"gggg":
            case"GGGG":
            case"GGGGG":
                a = a.substr(0, 2), b && (c._w = c._w || {}, c._w[a] = C(b));
                break;
            case"gg":
            case"GG":
                c._w = c._w || {}, c._w[a] = vb.parseTwoDigitYear(b)
        }
    }

    function U(a)
    {
        var c, d, e, f, g, h, i;
        c = a._w, null != c.GG || null != c.W || null != c.E? (g = 1, h = 4, d = b(c.GG, a._a[Cb], jb(vb(), 1, 4).year), e = b(c.W, 1), f = b(c.E, 1)) : (g = a._locale._week.dow, h = a._locale._week.doy, d = b(c.gg, a._a[Cb], jb(vb(), g, h).year), e = b(c.w, 1), null != c.d? (f = c.d, g > f && ++e) : f = null != c.e? c.e + g : g), i = kb(d, e, f, h, g), a._a[Cb] = i.year, a._dayOfYear = i.dayOfYear
    }

    function V(a)
    {
        var c, d, e, f, g = [];
        if(!a._d)
        {
            for(e = X(a), a._w && null == a._a[Eb] && null == a._a[Db] && U(a), a._dayOfYear && (f = b(a._a[Cb], e[Cb]), a._dayOfYear > F(f) && (a._pf._overflowDayOfYear = !0), d = fb(f, 0, a._dayOfYear), a._a[Db] = d.getUTCMonth(), a._a[Eb] = d.getUTCDate()), c = 0 ; 3 > c && null == a._a[c] ; ++c) a._a[c] = g[c] = e[c];
            for(; 7 > c ; c++) a._a[c] = g[c] = null == a._a[c]? 2 === c? 1 : 0 : a._a[c];
            24 === a._a[Fb] && 0 === a._a[Gb] && 0 === a._a[Hb] && 0 === a._a[Ib] && (a._nextDay = !0, a._a[Fb] = 0), a._d = (a._useUTC? fb : eb).apply(null, g), null != a._tzm && a._d.setUTCMinutes(a._d.getUTCMinutes() - a._tzm), a._nextDay && (a._a[Fb] = 24)
        }
    }

    function W(a)
    {
        var b;
        a._d || (b = A(a._i), a._a = [b.year, b.month, b.day || b.date, b.hour, b.minute, b.second, b.millisecond], V(a))
    }

    function X(a)
    {
        var b = new Date;
        return a._useUTC? [b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()] : [b.getFullYear(), b.getMonth(), b.getDate()]
    }

    function Y(b)
    {
        if(b._f === vb.ISO_8601) return void ab(b);
        b._a = [], b._pf.empty = !0;
        var c, d, e, f, g, h = "" + b._i, i = h.length, j = 0;
        for(e = Q(b._f, b._locale).match(Pb) || [], c = 0 ; c < e.length ; c++) f = e[c], d = (h.match(R(f, b)) || [])[0], d && (g = h.substr(0, h.indexOf(d)), g.length > 0 && b._pf.unusedInput.push(g), h = h.slice(h.indexOf(d) + d.length), j += d.length), rc[f]? (d? b._pf.empty = !1 : b._pf.unusedTokens.push(f), T(f, d, b)) : b._strict && !d && b._pf.unusedTokens.push(f);
        b._pf.charsLeftOver = i - j, h.length > 0 && b._pf.unusedInput.push(h), b._pf.bigHour === !0 && b._a[Fb] <= 12 && (b._pf.bigHour = a), b._a[Fb] = k(b._locale, b._a[Fb], b._meridiem), V(b), H(b)
    }

    function Z(a)
    {
        return a.replace(/\\(\[)|\\(\])|\[([^\]\[]*)\]|\\(.)/g, function(a, b, c, d, e){
            return b || c || d || e
        })
    }

    function $(a)
    {
        return a.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
    }

    function _(a)
    {
        var b, c, e, f, g;
        if(0 === a._f.length) return a._pf.invalidFormat = !0, void(a._d = new Date(0 / 0));
        for(f = 0 ; f < a._f.length ; f++) g = 0, b = p({}, a), null != a._useUTC && (b._useUTC = a._useUTC), b._pf = d(), b._f = a._f[f], Y(b), I(b) && (g += b._pf.charsLeftOver, g += 10 * b._pf.unusedTokens.length, b._pf.score = g, (null == e || e > g) && (e = g, c = b));
        o(a, c || b)
    }

    function ab(a)
    {
        var b, c, d = a._i, e = fc.exec(d);
        if(e)
        {
            for(a._pf.iso = !0, b = 0, c = hc.length ; c > b ; b++) if(hc[b][1].exec(d))
            {
                a._f = hc[b][0] + (e[6] || " ");
                break
            }
            for(b = 0, c = ic.length ; c > b ; b++) if(ic[b][1].exec(d))
            {
                a._f += ic[b][0];
                break
            }
            d.match(Xb) && (a._f += "Z"), Y(a)
        }
        else a._isValid = !1
    }

    function bb(a)
    {
        ab(a), a._isValid === !1 && (delete a._isValid, vb.createFromInputFallback(a))
    }

    function cb(a, b)
    {
        var c, d = [];
        for(c = 0 ; c < a.length ; ++c) d.push(b(a[c], c));
        return d
    }

    function db(b)
    {
        var c, d = b._i;
        d === a? b._d = new Date : x(d)? b._d = new Date(+d) : null !== (c = Mb.exec(d))? b._d = new Date(+c[1]) : "string" == typeof d? bb(b) : w(d)? (b._a = cb(d.slice(0), function(a){
            return parseInt(a, 10)
        }), V(b)) : "object" == typeof d? W(b) : "number" == typeof d? b._d = new Date(d) : vb.createFromInputFallback(b)
    }

    function eb(a, b, c, d, e, f, g)
    {
        var h = new Date(a, b, c, d, e, f, g);
        return 1970 > a && h.setFullYear(a), h
    }

    function fb(a)
    {
        var b = new Date(Date.UTC.apply(null, arguments));
        return 1970 > a && b.setUTCFullYear(a), b
    }

    function gb(a, b)
    {
        if("string" == typeof a) if(isNaN(a))
        {
            if(a = b.weekdaysParse(a), "number" != typeof a) return null
        }
        else a = parseInt(a, 10);
        return a
    }

    function hb(a, b, c, d, e)
    {
        return e.relativeTime(b || 1, !!c, a, d)
    }

    function ib(a, b, c)
    {
        var d = vb.duration(a).abs(), e = Ab(d.as("s")), f = Ab(d.as("m")), g = Ab(d.as("h")), h = Ab(d.as("d")),
            i = Ab(d.as("M")), j = Ab(d.as("y")),
            k = e < oc.s && ["s", e] || 1 === f && ["m"] || f < oc.m && ["mm", f] || 1 === g && ["h"] || g < oc.h && ["hh", g] || 1 === h && ["d"] || h < oc.d && ["dd", h] || 1 === i && ["M"] || i < oc.M && ["MM", i] || 1 === j && ["y"] || ["yy", j];
        return k[2] = b, k[3] = +a > 0, k[4] = c, hb.apply({}, k)
    }

    function jb(a, b, c)
    {
        var d, e = c - b, f = c - a.day();
        return f > e && (f -= 7), e - 7 > f && (f += 7), d = vb(a).add(f, "d"), {
            week: Math.ceil(d.dayOfYear() / 7),
            year: d.year()
        }
    }

    function kb(a, b, c, d, e)
    {
        var f, g, h = fb(a, 0, 1).getUTCDay();
        return h = 0 === h? 7 : h, c = null != c? c : e, f = e - h + (h > d? 7 : 0) - (e > h? 7 : 0), g = 7 * (b - 1) + (c - e) + f + 1, {
            year     : g > 0? a : a - 1,
            dayOfYear: g > 0? g : F(a - 1) + g
        }
    }

    function lb(b)
    {
        var c, d = b._i, e = b._f;
        return b._locale = b._locale || vb.localeData(b._l), null === d || e === a && "" === d? vb.invalid({nullInput: !0}) : ("string" == typeof d && (b._i = d = b._locale.preparse(d)), vb.isMoment(d)? new m(d, !0) : (e? w(e)? _(b) : Y(b) : db(b), c = new m(b), c._nextDay && (c.add(1, "d"), c._nextDay = a), c))
    }

    function mb(a, b)
    {
        var c, d;
        if(1 === b.length && w(b[0]) && (b = b[0]), !b.length) return vb();
        for(c = b[0], d = 1 ; d < b.length ; ++d) b[d][a](c) && (c = b[d]);
        return c
    }

    function nb(a, b)
    {
        var c;
        return "string" == typeof b && (b = a.localeData().monthsParse(b), "number" != typeof b)? a : (c = Math.min(a.date(), D(a.year(), b)), a._d["set" + (a._isUTC? "UTC" : "") + "Month"](b, c), a)
    }

    function ob(a, b)
    {
        return a._d["get" + (a._isUTC? "UTC" : "") + b]()
    }

    function pb(a, b, c)
    {
        return "Month" === b? nb(a, c) : a._d["set" + (a._isUTC? "UTC" : "") + b](c)
    }

    function qb(a, b)
    {
        return function(c){
            return null != c? (pb(this, a, c), vb.updateOffset(this, b), this) : ob(this, a)
        }
    }

    function rb(a)
    {
        return 400 * a / 146097
    }

    function sb(a)
    {
        return 146097 * a / 400
    }

    function tb(a)
    {
        vb.duration.fn[a] = function(){
            return this._data[a]
        }
    }

    function ub(a)
    {
        "undefined" == typeof ender && (wb = zb.moment, zb.moment = a? f("Accessing Moment through the global scope is deprecated, and will be removed in an upcoming release.", vb) : vb)
    }

    for(var vb, wb, xb, yb = "2.9.0", zb = "undefined" == typeof global || "undefined" != typeof window && window !== global.window? this : global, Ab = Math.round, Bb = Object.prototype.hasOwnProperty, Cb = 0, Db = 1, Eb = 2, Fb = 3, Gb = 4, Hb = 5, Ib = 6, Jb = {}, Kb = [], Lb = "undefined" != typeof module && module && module.exports, Mb = /^\/?Date\((\-?\d+)/i, Nb = /(\-)?(?:(\d*)\.)?(\d+)\:(\d+)(?:\:(\d+)\.?(\d{3})?)?/, Ob = /^(-)?P(?:(?:([0-9,.]*)Y)?(?:([0-9,.]*)M)?(?:([0-9,.]*)D)?(?:T(?:([0-9,.]*)H)?(?:([0-9,.]*)M)?(?:([0-9,.]*)S)?)?|([0-9,.]*)W)$/, Pb = /(\[[^\[]*\])|(\\)?(Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Q|YYYYYY|YYYYY|YYYY|YY|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|mm?|ss?|S{1,4}|x|X|zz?|ZZ?|.)/g, Qb = /(\[[^\[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g, Rb = /\d\d?/, Sb = /\d{1,3}/, Tb = /\d{1,4}/, Ub = /[+\-]?\d{1,6}/, Vb = /\d+/, Wb = /[0-9]*['a-z\u00A0-\u05FF\u0700-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]+|[\u0600-\u06FF\/]+(\s*?[\u0600-\u06FF]+){1,2}/i, Xb = /Z|[\+\-]\d\d:?\d\d/gi, Yb = /T/i, Zb = /[\+\-]?\d+/, $b = /[\+\-]?\d+(\.\d{1,3})?/, _b = /\d/, ac = /\d\d/, bc = /\d{3}/, cc = /\d{4}/, dc = /[+-]?\d{6}/, ec = /[+-]?\d+/, fc = /^\s*(?:[+-]\d{6}|\d{4})-(?:(\d\d-\d\d)|(W\d\d$)|(W\d\d-\d)|(\d\d\d))((T| )(\d\d(:\d\d(:\d\d(\.\d+)?)?)?)?([\+\-]\d\d(?::?\d\d)?|\s*Z)?)?$/, gc = "YYYY-MM-DDTHH:mm:ssZ", hc = [["YYYYYY-MM-DD", /[+-]\d{6}-\d{2}-\d{2}/], ["YYYY-MM-DD", /\d{4}-\d{2}-\d{2}/], ["GGGG-[W]WW-E", /\d{4}-W\d{2}-\d/], ["GGGG-[W]WW", /\d{4}-W\d{2}/], ["YYYY-DDD", /\d{4}-\d{3}/]], ic = [["HH:mm:ss.SSSS", /(T| )\d\d:\d\d:\d\d\.\d+/], ["HH:mm:ss", /(T| )\d\d:\d\d:\d\d/], ["HH:mm", /(T| )\d\d:\d\d/], ["HH", /(T| )\d\d/]], jc = /([\+\-]|\d\d)/gi, kc = ("Date|Hours|Minutes|Seconds|Milliseconds".split("|"), {
        Milliseconds: 1,
        Seconds     : 1e3,
        Minutes     : 6e4,
        Hours       : 36e5,
        Days        : 864e5,
        Months      : 2592e6,
        Years       : 31536e6
    }), lc = {
        ms : "millisecond",
        s  : "second",
        m  : "minute",
        h  : "hour",
        d  : "day",
        D  : "date",
        w  : "week",
        W  : "isoWeek",
        M  : "month",
        Q  : "quarter",
        y  : "year",
        DDD: "dayOfYear",
        e  : "weekday",
        E  : "isoWeekday",
        gg : "weekYear",
        GG : "isoWeekYear"
    }, mc = {
        dayofyear  : "dayOfYear",
        isoweekday : "isoWeekday",
        isoweek    : "isoWeek",
        weekyear   : "weekYear",
        isoweekyear: "isoWeekYear"
    }, nc = {}, oc = {
        s: 45,
        m: 45,
        h: 22,
        d: 26,
        M: 11
    }, pc = "DDD w W M D d".split(" "), qc = "M D H h m s w W".split(" "), rc = {
        M        : function(){
            return this.month() + 1
        }, MMM   : function(a){
            return this.localeData().monthsShort(this, a)
        }, MMMM  : function(a){
            return this.localeData().months(this, a)
        }, D     : function(){
            return this.date()
        }, DDD   : function(){
            return this.dayOfYear()
        }, d     : function(){
            return this.day()
        }, dd    : function(a){
            return this.localeData().weekdaysMin(this, a)
        }, ddd   : function(a){
            return this.localeData().weekdaysShort(this, a)
        }, dddd  : function(a){
            return this.localeData().weekdays(this, a)
        }, w     : function(){
            return this.week()
        }, W     : function(){
            return this.isoWeek()
        }, YY    : function(){
            return r(this.year() % 100, 2)
        }, YYYY  : function(){
            return r(this.year(), 4)
        }, YYYYY : function(){
            return r(this.year(), 5)
        }, YYYYYY: function(){
            var a = this.year(), b = a >= 0? "+" : "-";
            return b + r(Math.abs(a), 6)
        }, gg    : function(){
            return r(this.weekYear() % 100, 2)
        }, gggg  : function(){
            return r(this.weekYear(), 4)
        }, ggggg : function(){
            return r(this.weekYear(), 5)
        }, GG    : function(){
            return r(this.isoWeekYear() % 100, 2)
        }, GGGG  : function(){
            return r(this.isoWeekYear(), 4)
        }, GGGGG : function(){
            return r(this.isoWeekYear(), 5)
        }, e     : function(){
            return this.weekday()
        }, E     : function(){
            return this.isoWeekday()
        }, a     : function(){
            return this.localeData().meridiem(this.hours(), this.minutes(), !0)
        }, A     : function(){
            return this.localeData().meridiem(this.hours(), this.minutes(), !1)
        }, H     : function(){
            return this.hours()
        }, h     : function(){
            return this.hours() % 12 || 12
        }, m     : function(){
            return this.minutes()
        }, s     : function(){
            return this.seconds()
        }, S     : function(){
            return C(this.milliseconds() / 100)
        }, SS    : function(){
            return r(C(this.milliseconds() / 10), 2)
        }, SSS   : function(){
            return r(this.milliseconds(), 3)
        }, SSSS  : function(){
            return r(this.milliseconds(), 3)
        }, Z     : function(){
            var a = this.utcOffset(), b = "+";
            return 0 > a && (a = -a, b = "-"), b + r(C(a / 60), 2) + ":" + r(C(a) % 60, 2)
        }, ZZ    : function(){
            var a = this.utcOffset(), b = "+";
            return 0 > a && (a = -a, b = "-"), b + r(C(a / 60), 2) + r(C(a) % 60, 2)
        }, z     : function(){
            return this.zoneAbbr()
        }, zz    : function(){
            return this.zoneName()
        }, x     : function(){
            return this.valueOf()
        }, X     : function(){
            return this.unix()
        }, Q     : function(){
            return this.quarter()
        }
    }, sc = {}, tc = ["months", "monthsShort", "weekdays", "weekdaysShort", "weekdaysMin"], uc = !1 ; pc.length ;) xb = pc.pop(), rc[xb + "o"] = i(rc[xb], xb);
    for(; qc.length ;) xb = qc.pop(), rc[xb + xb] = h(rc[xb], 2);
    rc.DDDD = h(rc.DDD, 3), o(l.prototype, {
        set            : function(a){
            var b, c;
            for(c in a) b = a[c], "function" == typeof b? this[c] = b : this["_" + c] = b;
            this._ordinalParseLenient = new RegExp(this._ordinalParse.source + "|" + /\d{1,2}/.source)
        },
        _months        : "January_February_March_April_May_June_July_August_September_October_November_December".split("_"),
        months         : function(a){
            return this._months[a.month()]
        },
        _monthsShort   : "Jan_Feb_Mar_Apr_May_Jun_Jul_Aug_Sep_Oct_Nov_Dec".split("_"),
        monthsShort    : function(a){
            return this._monthsShort[a.month()]
        },
        monthsParse    : function(a, b, c){
            var d, e, f;
            for(this._monthsParse || (this._monthsParse = [], this._longMonthsParse = [], this._shortMonthsParse = []), d = 0 ; 12 > d ; d++)
            {
                if(e = vb.utc([2e3, d]), c && !this._longMonthsParse[d] && (this._longMonthsParse[d] = new RegExp("^" + this.months(e, "").replace(".", "") + "$", "i"), this._shortMonthsParse[d] = new RegExp("^" + this.monthsShort(e, "").replace(".", "") + "$", "i")), c || this._monthsParse[d] || (f = "^" + this.months(e, "") + "|^" + this.monthsShort(e, ""), this._monthsParse[d] = new RegExp(f.replace(".", ""), "i")), c && "MMMM" === b && this._longMonthsParse[d].test(a)) return d;
                if(c && "MMM" === b && this._shortMonthsParse[d].test(a)) return d;
                if(!c && this._monthsParse[d].test(a)) return d
            }
        },
        _weekdays      : "Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday".split("_"),
        weekdays       : function(a){
            return this._weekdays[a.day()]
        },
        _weekdaysShort : "Sun_Mon_Tue_Wed_Thu_Fri_Sat".split("_"),
        weekdaysShort  : function(a){
            return this._weekdaysShort[a.day()]
        },
        _weekdaysMin   : "Su_Mo_Tu_We_Th_Fr_Sa".split("_"),
        weekdaysMin    : function(a){
            return this._weekdaysMin[a.day()]
        },
        weekdaysParse  : function(a){
            var b, c, d;
            for(this._weekdaysParse || (this._weekdaysParse = []), b = 0 ; 7 > b ; b++) if(this._weekdaysParse[b] || (c = vb([2e3, 1]).day(b), d = "^" + this.weekdays(c, "") + "|^" + this.weekdaysShort(c, "") + "|^" + this.weekdaysMin(c, ""), this._weekdaysParse[b] = new RegExp(d.replace(".", ""), "i")), this._weekdaysParse[b].test(a)) return b
        },
        _longDateFormat: {
            LTS : "h:mm:ss A",
            LT  : "h:mm A",
            L   : "MM/DD/YYYY",
            LL  : "MMMM D, YYYY",
            LLL : "MMMM D, YYYY LT",
            LLLL: "dddd, MMMM D, YYYY LT"
        },
        longDateFormat : function(a){
            var b = this._longDateFormat[a];
            return !b && this._longDateFormat[a.toUpperCase()] && (b = this._longDateFormat[a.toUpperCase()].replace(/MMMM|MM|DD|dddd/g, function(a){
                return a.slice(1)
            }), this._longDateFormat[a] = b), b
        },
        isPM           : function(a){
            return "p" === (a + "").toLowerCase().charAt(0)
        },
        _meridiemParse : /[ap]\.?m?\.?/i,
        meridiem       : function(a, b, c){
            return a > 11? c? "pm" : "PM" : c? "am" : "AM"
        },
        _calendar      : {
            sameDay : "[Today at] LT",
            nextDay : "[Tomorrow at] LT",
            nextWeek: "dddd [at] LT",
            lastDay : "[Yesterday at] LT",
            lastWeek: "[Last] dddd [at] LT",
            sameElse: "L"
        },
        calendar       : function(a, b, c){
            var d = this._calendar[a];
            return "function" == typeof d? d.apply(b, [c]) : d
        },
        _relativeTime  : {
            future: "in %s",
            past  : "%s ago",
            s     : "a few seconds",
            m     : "a minute",
            mm    : "%d minutes",
            h     : "an hour",
            hh    : "%d hours",
            d     : "a day",
            dd    : "%d days",
            M     : "a month",
            MM    : "%d months",
            y     : "a year",
            yy    : "%d years"
        },
        relativeTime   : function(a, b, c, d){
            var e = this._relativeTime[c];
            return "function" == typeof e? e(a, b, c, d) : e.replace(/%d/i, a)
        },
        pastFuture     : function(a, b){
            var c = this._relativeTime[a > 0? "future" : "past"];
            return "function" == typeof c? c(b) : c.replace(/%s/i, b)
        },
        ordinal        : function(a){
            return this._ordinal.replace("%d", a)
        },
        _ordinal       : "%d",
        _ordinalParse  : /\d{1,2}/,
        preparse       : function(a){
            return a
        },
        postformat     : function(a){
            return a
        },
        week           : function(a){
            return jb(a, this._week.dow, this._week.doy).week
        },
        _week          : {dow: 0, doy: 6},
        firstDayOfWeek : function(){
            return this._week.dow
        },
        firstDayOfYear : function(){
            return this._week.doy
        },
        _invalidDate   : "Invalid date",
        invalidDate    : function(){
            return this._invalidDate
        }
    }), vb = function(b, c, e, f){
        var g;
        return "boolean" == typeof e && (f = e, e = a), g = {}, g._isAMomentObject = !0, g._i = b, g._f = c, g._l = e, g._strict = f, g._isUTC = !1, g._pf = d(), lb(g)
    }, vb.suppressDeprecationWarnings = !1, vb.createFromInputFallback = f("moment construction falls back to js Date. This is discouraged and will be removed in upcoming major release. Please refer to https://github.com/moment/moment/issues/1407 for more info.", function(a){
        a._d = new Date(a._i + (a._useUTC? " UTC" : ""))
    }), vb.min = function(){
        var a = [].slice.call(arguments, 0);
        return mb("isBefore", a)
    }, vb.max = function(){
        var a = [].slice.call(arguments, 0);
        return mb("isAfter", a)
    }, vb.utc = function(b, c, e, f){
        var g;
        return "boolean" == typeof e && (f = e, e = a), g = {}, g._isAMomentObject = !0, g._useUTC = !0, g._isUTC = !0, g._l = e, g._i = b, g._f = c, g._strict = f, g._pf = d(), lb(g).utc()
    }, vb.unix = function(a){
        return vb(1e3 * a)
    }, vb.duration = function(a, b){
        var d, e, f, g, h = a, i = null;
        return vb.isDuration(a)? h = {
            ms: a._milliseconds,
            d : a._days,
            M : a._months
        } : "number" == typeof a? (h = {}, b? h[b] = a : h.milliseconds = a) : (i = Nb.exec(a))? (d = "-" === i[1]? -1 : 1, h = {
            y : 0,
            d : C(i[Eb]) * d,
            h : C(i[Fb]) * d,
            m : C(i[Gb]) * d,
            s : C(i[Hb]) * d,
            ms: C(i[Ib]) * d
        }) : (i = Ob.exec(a))? (d = "-" === i[1]? -1 : 1, f = function(a){
            var b = a && parseFloat(a.replace(",", "."));
            return (isNaN(b)? 0 : b) * d
        }, h = {
            y: f(i[2]),
            M: f(i[3]),
            d: f(i[4]),
            h: f(i[5]),
            m: f(i[6]),
            s: f(i[7]),
            w: f(i[8])
        }) : null == h? h = {} : "object" == typeof h && ("from" in h || "to" in h) && (g = t(vb(h.from), vb(h.to)), h = {}, h.ms = g.milliseconds, h.M = g.months), e = new n(h), vb.isDuration(a) && c(a, "_locale") && (e._locale = a._locale), e
    }, vb.version = yb, vb.defaultFormat = gc, vb.ISO_8601 = function(){
    }, vb.momentProperties = Kb, vb.updateOffset = function(){
    }, vb.relativeTimeThreshold = function(b, c){
        return oc[b] === a? !1 : c === a? oc[b] : (oc[b] = c, !0)
    }, vb.lang = f("moment.lang is deprecated. Use moment.locale instead.", function(a, b){
        return vb.locale(a, b)
    }), vb.locale = function(a, b){
        var c;
        return a && (c = "undefined" != typeof b? vb.defineLocale(a, b) : vb.localeData(a), c && (vb.duration._locale = vb._locale = c)), vb._locale._abbr
    }, vb.defineLocale = function(a, b){
        return null !== b? (b.abbr = a, Jb[a] || (Jb[a] = new l), Jb[a].set(b), vb.locale(a), Jb[a]) : (delete Jb[a], null)
    }, vb.langData = f("moment.langData is deprecated. Use moment.localeData instead.", function(a){
        return vb.localeData(a)
    }), vb.localeData = function(a){
        var b;
        if(a && a._locale && a._locale._abbr && (a = a._locale._abbr), !a) return vb._locale;
        if(!w(a))
        {
            if(b = L(a)) return b;
            a = [a]
        }
        return K(a)
    }, vb.isMoment = function(a){
        return a instanceof m || null != a && c(a, "_isAMomentObject")
    }, vb.isDuration = function(a){
        return a instanceof n
    };
    for(xb = tc.length - 1 ; xb >= 0 ; --xb) B(tc[xb]);
    vb.normalizeUnits = function(a){
        return z(a)
    }, vb.invalid = function(a){
        var b = vb.utc(0 / 0);
        return null != a? o(b._pf, a) : b._pf.userInvalidated = !0, b
    }, vb.parseZone = function(){
        return vb.apply(null, arguments).parseZone()
    }, vb.parseTwoDigitYear = function(a){
        return C(a) + (C(a) > 68? 1900 : 2e3)
    }, vb.isDate = x, o(vb.fn = m.prototype, {
        clone               : function(){
            return vb(this)
        },
        valueOf             : function(){
            return +this._d - 6e4 * (this._offset || 0)
        },
        unix                : function(){
            return Math.floor(+this / 1e3)
        },
        toString            : function(){
            return this.clone().locale("en").format("ddd MMM DD YYYY HH:mm:ss [GMT]ZZ")
        },
        toDate              : function(){
            return this._offset? new Date(+this) : this._d
        },
        toISOString         : function(){
            var a = vb(this).utc();
            return 0 < a.year() && a.year() <= 9999? "function" == typeof Date.prototype.toISOString? this.toDate().toISOString() : P(a, "YYYY-MM-DD[T]HH:mm:ss.SSS[Z]") : P(a, "YYYYYY-MM-DD[T]HH:mm:ss.SSS[Z]")
        },
        toArray             : function(){
            var a = this;
            return [a.year(), a.month(), a.date(), a.hours(), a.minutes(), a.seconds(), a.milliseconds()]
        },
        isValid             : function(){
            return I(this)
        },
        isDSTShifted        : function(){
            return this._a? this.isValid() && y(this._a, (this._isUTC? vb.utc(this._a) : vb(this._a)).toArray()) > 0 : !1
        },
        parsingFlags        : function(){
            return o({}, this._pf)
        },
        invalidAt           : function(){
            return this._pf.overflow
        },
        utc                 : function(a){
            return this.utcOffset(0, a)
        },
        local               : function(a){
            return this._isUTC && (this.utcOffset(0, a), this._isUTC = !1, a && this.subtract(this._dateUtcOffset(), "m")), this
        },
        format              : function(a){
            var b = P(this, a || vb.defaultFormat);
            return this.localeData().postformat(b)
        },
        add                 : u(1, "add"),
        subtract            : u(-1, "subtract"),
        diff                : function(a, b, c){
            var d, e, f = M(a, this), g = 6e4 * (f.utcOffset() - this.utcOffset());
            return b = z(b), "year" === b || "month" === b || "quarter" === b? (e = j(this, f), "quarter" === b? e /= 3 : "year" === b && (e /= 12)) : (d = this - f, e = "second" === b? d / 1e3 : "minute" === b? d / 6e4 : "hour" === b? d / 36e5 : "day" === b? (d - g) / 864e5 : "week" === b? (d - g) / 6048e5 : d), c? e : q(e)
        },
        from                : function(a, b){
            return vb.duration({to: this, from: a}).locale(this.locale()).humanize(!b)
        },
        fromNow             : function(a){
            return this.from(vb(), a)
        },
        calendar            : function(a){
            var b = a || vb(), c = M(b, this).startOf("day"), d = this.diff(c, "days", !0),
                e = -6 > d? "sameElse" : -1 > d? "lastWeek" : 0 > d? "lastDay" : 1 > d? "sameDay" : 2 > d? "nextDay" : 7 > d? "nextWeek" : "sameElse";
            return this.format(this.localeData().calendar(e, this, vb(b)))
        },
        isLeapYear          : function(){
            return G(this.year())
        },
        isDST               : function(){
            return this.utcOffset() > this.clone().month(0).utcOffset() || this.utcOffset() > this.clone().month(5).utcOffset()
        },
        day                 : function(a){
            var b = this._isUTC? this._d.getUTCDay() : this._d.getDay();
            return null != a? (a = gb(a, this.localeData()), this.add(a - b, "d")) : b
        },
        month               : qb("Month", !0),
        startOf             : function(a){
            switch(a = z(a))
            {
                case"year":
                    this.month(0);
                case"quarter":
                case"month":
                    this.date(1);
                case"week":
                case"isoWeek":
                case"day":
                    this.hours(0);
                case"hour":
                    this.minutes(0);
                case"minute":
                    this.seconds(0);
                case"second":
                    this.milliseconds(0)
            }
            return "week" === a? this.weekday(0) : "isoWeek" === a && this.isoWeekday(1), "quarter" === a && this.month(3 * Math.floor(this.month() / 3)), this
        },
        endOf               : function(b){
            return b = z(b), b === a || "millisecond" === b? this : this.startOf(b).add(1, "isoWeek" === b? "week" : b).subtract(1, "ms")
        },
        isAfter             : function(a, b){
            var c;
            return b = z("undefined" != typeof b? b : "millisecond"), "millisecond" === b? (a = vb.isMoment(a)? a : vb(a), +this > +a) : (c = vb.isMoment(a)? +a : +vb(a), c < +this.clone().startOf(b))
        },
        isBefore            : function(a, b){
            var c;
            return b = z("undefined" != typeof b? b : "millisecond"), "millisecond" === b? (a = vb.isMoment(a)? a : vb(a), +a > +this) : (c = vb.isMoment(a)? +a : +vb(a), +this.clone().endOf(b) < c)
        },
        isBetween           : function(a, b, c){
            return this.isAfter(a, c) && this.isBefore(b, c)
        },
        isSame              : function(a, b){
            var c;
            return b = z(b || "millisecond"), "millisecond" === b? (a = vb.isMoment(a)? a : vb(a), +this === +a) : (c = +vb(a), +this.clone().startOf(b) <= c && c <= +this.clone().endOf(b))
        },
        min                 : f("moment().min is deprecated, use moment.min instead. https://github.com/moment/moment/issues/1548", function(a){
            return a = vb.apply(null, arguments), this > a? this : a
        }),
        max                 : f("moment().max is deprecated, use moment.max instead. https://github.com/moment/moment/issues/1548", function(a){
            return a = vb.apply(null, arguments), a > this? this : a
        }),
        zone                : f("moment().zone is deprecated, use moment().utcOffset instead. https://github.com/moment/moment/issues/1779", function(a, b){
            return null != a? ("string" != typeof a && (a = -a), this.utcOffset(a, b), this) : -this.utcOffset()
        }),
        utcOffset           : function(a, b){
            var c, d = this._offset || 0;
            return null != a? ("string" == typeof a && (a = S(a)), Math.abs(a) < 16 && (a = 60 * a), !this._isUTC && b && (c = this._dateUtcOffset()), this._offset = a, this._isUTC = !0, null != c && this.add(c, "m"), d !== a && (!b || this._changeInProgress? v(this, vb.duration(a - d, "m"), 1, !1) : this._changeInProgress || (this._changeInProgress = !0, vb.updateOffset(this, !0), this._changeInProgress = null)), this) : this._isUTC? d : this._dateUtcOffset()
        },
        isLocal             : function(){
            return !this._isUTC
        },
        isUtcOffset         : function(){
            return this._isUTC
        },
        isUtc               : function(){
            return this._isUTC && 0 === this._offset
        },
        zoneAbbr            : function(){
            return this._isUTC? "UTC" : ""
        },
        zoneName            : function(){
            return this._isUTC? "Coordinated Universal Time" : ""
        },
        parseZone           : function(){
            return this._tzm? this.utcOffset(this._tzm) : "string" == typeof this._i && this.utcOffset(S(this._i)), this
        },
        hasAlignedHourOffset: function(a){
            return a = a? vb(a).utcOffset() : 0, (this.utcOffset() - a) % 60 === 0
        },
        daysInMonth         : function(){
            return D(this.year(), this.month())
        },
        dayOfYear           : function(a){
            var b = Ab((vb(this).startOf("day") - vb(this).startOf("year")) / 864e5) + 1;
            return null == a? b : this.add(a - b, "d")
        },
        quarter             : function(a){
            return null == a? Math.ceil((this.month() + 1) / 3) : this.month(3 * (a - 1) + this.month() % 3)
        },
        weekYear            : function(a){
            var b = jb(this, this.localeData()._week.dow, this.localeData()._week.doy).year;
            return null == a? b : this.add(a - b, "y")
        },
        isoWeekYear         : function(a){
            var b = jb(this, 1, 4).year;
            return null == a? b : this.add(a - b, "y")
        },
        week                : function(a){
            var b = this.localeData().week(this);
            return null == a? b : this.add(7 * (a - b), "d")
        },
        isoWeek             : function(a){
            var b = jb(this, 1, 4).week;
            return null == a? b : this.add(7 * (a - b), "d")
        },
        weekday             : function(a){
            var b = (this.day() + 7 - this.localeData()._week.dow) % 7;
            return null == a? b : this.add(a - b, "d")
        },
        isoWeekday          : function(a){
            return null == a? this.day() || 7 : this.day(this.day() % 7? a : a - 7)
        },
        isoWeeksInYear      : function(){
            return E(this.year(), 1, 4)
        },
        weeksInYear         : function(){
            var a = this.localeData()._week;
            return E(this.year(), a.dow, a.doy)
        },
        get                 : function(a){
            return a = z(a), this[a]()
        },
        set                 : function(a, b){
            var c;
            if("object" == typeof a) for(c in a) this.set(c, a[c]);
            else a = z(a), "function" == typeof this[a] && this[a](b);
            return this
        },
        locale              : function(b){
            var c;
            return b === a? this._locale._abbr : (c = vb.localeData(b), null != c && (this._locale = c), this)
        },
        lang                : f("moment().lang() is deprecated. Instead, use moment().localeData() to get the language configuration. Use moment().locale() to change languages.", function(b){
            return b === a? this.localeData() : this.locale(b)
        }),
        localeData          : function(){
            return this._locale
        },
        _dateUtcOffset      : function(){
            return 15 * -Math.round(this._d.getTimezoneOffset() / 15)
        }
    }), vb.fn.millisecond = vb.fn.milliseconds = qb("Milliseconds", !1), vb.fn.second = vb.fn.seconds = qb("Seconds", !1), vb.fn.minute = vb.fn.minutes = qb("Minutes", !1), vb.fn.hour = vb.fn.hours = qb("Hours", !0), vb.fn.date = qb("Date", !0), vb.fn.dates = f("dates accessor is deprecated. Use date instead.", qb("Date", !0)), vb.fn.year = qb("FullYear", !0), vb.fn.years = f("years accessor is deprecated. Use year instead.", qb("FullYear", !0)), vb.fn.days = vb.fn.day, vb.fn.months = vb.fn.month, vb.fn.weeks = vb.fn.week, vb.fn.isoWeeks = vb.fn.isoWeek, vb.fn.quarters = vb.fn.quarter, vb.fn.toJSON = vb.fn.toISOString, vb.fn.isUTC = vb.fn.isUtc, o(vb.duration.fn = n.prototype, {
        _bubble    : function(){
            var a, b, c, d = this._milliseconds, e = this._days, f = this._months, g = this._data, h = 0;
            g.milliseconds = d % 1e3, a = q(d / 1e3), g.seconds = a % 60, b = q(a / 60), g.minutes = b % 60, c = q(b / 60), g.hours = c % 24, e += q(c / 24), h = q(rb(e)), e -= q(sb(h)), f += q(e / 30), e %= 30, h += q(f / 12), f %= 12, g.days = e, g.months = f, g.years = h
        },
        abs        : function(){
            return this._milliseconds = Math.abs(this._milliseconds), this._days = Math.abs(this._days), this._months = Math.abs(this._months), this._data.milliseconds = Math.abs(this._data.milliseconds), this._data.seconds = Math.abs(this._data.seconds), this._data.minutes = Math.abs(this._data.minutes), this._data.hours = Math.abs(this._data.hours), this._data.months = Math.abs(this._data.months), this._data.years = Math.abs(this._data.years), this
        },
        weeks      : function(){
            return q(this.days() / 7)
        },
        valueOf    : function(){
            return this._milliseconds + 864e5 * this._days + this._months % 12 * 2592e6 + 31536e6 * C(this._months / 12)
        },
        humanize   : function(a){
            var b = ib(this, !a, this.localeData());
            return a && (b = this.localeData().pastFuture(+this, b)), this.localeData().postformat(b)
        },
        add        : function(a, b){
            var c = vb.duration(a, b);
            return this._milliseconds += c._milliseconds, this._days += c._days, this._months += c._months, this._bubble(), this
        },
        subtract   : function(a, b){
            var c = vb.duration(a, b);
            return this._milliseconds -= c._milliseconds, this._days -= c._days, this._months -= c._months, this._bubble(), this
        },
        get        : function(a){
            return a = z(a), this[a.toLowerCase() + "s"]()
        },
        as         : function(a){
            var b, c;
            if(a = z(a), "month" === a || "year" === a) return b = this._days + this._milliseconds / 864e5, c = this._months + 12 * rb(b), "month" === a? c : c / 12;
            switch(b = this._days + Math.round(sb(this._months / 12)), a)
            {
                case"week":
                    return b / 7 + this._milliseconds / 6048e5;
                case"day":
                    return b + this._milliseconds / 864e5;
                case"hour":
                    return 24 * b + this._milliseconds / 36e5;
                case"minute":
                    return 24 * b * 60 + this._milliseconds / 6e4;
                case"second":
                    return 24 * b * 60 * 60 + this._milliseconds / 1e3;
                case"millisecond":
                    return Math.floor(24 * b * 60 * 60 * 1e3) + this._milliseconds;
                default:
                    throw new Error("Unknown unit " + a)
            }
        },
        lang       : vb.fn.lang,
        locale     : vb.fn.locale,
        toIsoString: f("toIsoString() is deprecated. Please use toISOString() instead (notice the capitals)", function(){
            return this.toISOString()
        }),
        toISOString: function(){
            var a = Math.abs(this.years()), b = Math.abs(this.months()), c = Math.abs(this.days()),
                d = Math.abs(this.hours()), e = Math.abs(this.minutes()),
                f = Math.abs(this.seconds() + this.milliseconds() / 1e3);
            return this.asSeconds()? (this.asSeconds() < 0? "-" : "") + "P" + (a? a + "Y" : "") + (b? b + "M" : "") + (c? c + "D" : "") + (d || e || f? "T" : "") + (d? d + "H" : "") + (e? e + "M" : "") + (f? f + "S" : "") : "P0D"
        },
        localeData : function(){
            return this._locale
        },
        toJSON     : function(){
            return this.toISOString()
        }
    }), vb.duration.fn.toString = vb.duration.fn.toISOString;
    for(xb in kc) c(kc, xb) && tb(xb.toLowerCase());
    vb.duration.fn.asMilliseconds = function(){
        return this.as("ms")
    }, vb.duration.fn.asSeconds = function(){
        return this.as("s")
    }, vb.duration.fn.asMinutes = function(){
        return this.as("m")
    }, vb.duration.fn.asHours = function(){
        return this.as("h")
    }, vb.duration.fn.asDays = function(){
        return this.as("d")
    }, vb.duration.fn.asWeeks = function(){
        return this.as("weeks")
    }, vb.duration.fn.asMonths = function(){
        return this.as("M")
    }, vb.duration.fn.asYears = function(){
        return this.as("y")
    }, vb.locale("en", {
        ordinalParse: /\d{1,2}(th|st|nd|rd)/, ordinal: function(a){
            var b = a % 10, c = 1 === C(a % 100 / 10)? "th" : 1 === b? "st" : 2 === b? "nd" : 3 === b? "rd" : "th";
            return a + c
        }
    }), Lb? module.exports = vb : "function" == typeof define && define.amd? (define(function(a, b, c){
        return c.config && c.config() && c.config().noGlobal === !0 && (zb.moment = wb), vb
    }), ub(!0)) : ub()
}).call(this);

//Datetimepicker
var exports;
var obj;
!function(e){
    "use strict";
    var t = {
        i18n                  : {
            ar     : {
                months   : ["????? ??????", "????", "????", "?????", "????", "??????", "????", "??", "?????", "????? ?????", "????? ??????", "????? ?????"],
                dayOfWeek: ["?", "?", "?", "?", "?", "?", "?"]
            },
            ro     : {
                months   : ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"],
                dayOfWeek: ["l", "ma", "mi", "j", "v", "s", "d"]
            },
            id     : {
                months   : ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"],
                dayOfWeek: ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]
            },
            bg     : {
                months   : ["??????", "????????", "????", "?????", "???", "???", "???", "??????", "?????????", "????????", "???????", "????????"],
                dayOfWeek: ["??", "??", "??", "??", "??", "??", "??"]
            },
            fa     : {
                months   : ["???????", "????????", "?????", "???", "?????", "??????", "???", "????", "???", "??", "????", "?????"],
                dayOfWeek: ["??????", "??????", "?? ????", "????????", "???????", "????", "????"]
            },
            ru     : {
                months   : ["??????", "???????", "????", "??????", "???", "????", "????", "??????", "????????", "???????", "??????", "???????"],
                dayOfWeek: ["???", "??", "??", "??", "??", "??", "??"]
            },
            uk     : {
                months   : ["??????", "?????", "????????", "???????", "???????", "???????", "??????", "???????", "????????", "???????", "????????", "???????"],
                dayOfWeek: ["???", "???", "???", "???", "???", "???", "???"]
            },
            en     : {
                months   : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
                dayOfWeek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            },
            el     : {
                months   : ["??????????", "??ß????????", "???????", "????????", "?????", "???????", "???????", "?????????", "?????µß????", "????ß????", "???µß????", "????µß????"],
                dayOfWeek: ["???", "???", "???", "???", "??µ", "???", "??ß"]
            },
            de     : {
                months   : ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
                dayOfWeek: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]
            },
            nl     : {
                months   : ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"],
                dayOfWeek: ["zo", "ma", "di", "wo", "do", "vr", "za"]
            },
            tr     : {
                months   : ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"],
                dayOfWeek: ["Paz", "Pts", "Sal", "Çar", "Per", "Cum", "Cts"]
            },
            fr     : {
                months   : ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"],
                dayOfWeek: ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"]
            },
            es     : {
                months   : ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"],
                dayOfWeek: ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]
            },
            th     : {
                months   : ["??????", "??????????", "??????", "??????", "???????", "????????", "???????", "???????", "???????", "??????", "?????????", "???????"],
                dayOfWeek: ["??.", "?.", "?.", "?.", "??.", "?.", "?."]
            },
            pl     : {
                months   : ["styczen", "luty", "marzec", "kwiecien", "maj", "czerwiec", "lipiec", "sierpien", "wrzesien", "pazdziernik", "listopad", "grudzien"],
                dayOfWeek: ["nd", "pn", "wt", "sr", "cz", "pt", "sb"]
            },
            pt     : {
                months   : ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"],
                dayOfWeek: ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"]
            },
            ch     : {
                months   : ["??", "??", "??", "??", "??", "??", "??", "??", "??", "??", "???", "???"],
                dayOfWeek: ["?", "?", "?", "?", "?", "?", "?"]
            },
            se     : {
                months   : ["Januari", "Februari", "Mars", "April", "Maj", "Juni", "Juli", "Augusti", "September", "Oktober", "November", "December"],
                dayOfWeek: ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"]
            },
            kr     : {
                months   : ["1?", "2?", "3?", "4?", "5?", "6?", "7?", "8?", "9?", "10?", "11?", "12?"],
                dayOfWeek: ["?", "?", "?", "?", "?", "?", "?"]
            },
            it     : {
                months   : ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"],
                dayOfWeek: ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"]
            },
            da     : {
                months   : ["January", "Februar", "Marts", "April", "Maj", "Juni", "July", "August", "September", "Oktober", "November", "December"],
                dayOfWeek: ["Søn", "Man", "Tir", "Ons", "Tor", "Fre", "Lør"]
            },
            no     : {
                months   : ["Januar", "Februar", "Mars", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Desember"],
                dayOfWeek: ["Søn", "Man", "Tir", "Ons", "Tor", "Fre", "Lør"]
            },
            ja     : {
                months   : ["1?", "2?", "3?", "4?", "5?", "6?", "7?", "8?", "9?", "10?", "11?", "12?"],
                dayOfWeek: ["?", "?", "?", "?", "?", "?", "?"]
            },
            vi     : {
                months   : ["Tháng 1", "Tháng 2", "Tháng 3", "Tháng 4", "Tháng 5", "Tháng 6", "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10", "Tháng 11", "Tháng 12"],
                dayOfWeek: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"]
            },
            sl     : {
                months   : ["Januar", "Februar", "Marec", "April", "Maj", "Junij", "Julij", "Avgust", "September", "Oktober", "November", "December"],
                dayOfWeek: ["Ned", "Pon", "Tor", "Sre", "Cet", "Pet", "Sob"]
            },
            cs     : {
                months   : ["Leden", "Únor", "Brezen", "Duben", "Kveten", "Cerven", "Cervenec", "Srpen", "Zárí", "Ríjen", "Listopad", "Prosinec"],
                dayOfWeek: ["Ne", "Po", "Út", "St", "Ct", "Pá", "So"]
            },
            hu     : {
                months   : ["Január", "Február", "Március", "Április", "Május", "Június", "Július", "Augusztus", "Szeptember", "Október", "November", "December"],
                dayOfWeek: ["Va", "Hé", "Ke", "Sze", "Cs", "Pé", "Szo"]
            },
            az     : {
                months   : ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avqust", "Sentyabr", "Oktyabr", "Noyabr", "Dekabr"],
                dayOfWeek: ["B", "Be", "Ça", "Ç", "Ca", "C", "Þ"]
            },
            bs     : {
                months   : ["Januar", "Februar", "Mart", "April", "Maj", "Jun", "Jul", "Avgust", "Septembar", "Oktobar", "Novembar", "Decembar"],
                dayOfWeek: ["Ned", "Pon", "Uto", "Sri", "Cet", "Pet", "Sub"]
            },
            ca     : {
                months   : ["Gener", "Febrer", "Març", "Abril", "Maig", "Juny", "Juliol", "Agost", "Setembre", "Octubre", "Novembre", "Desembre"],
                dayOfWeek: ["Dg", "Dl", "Dt", "Dc", "Dj", "Dv", "Ds"]
            },
            "en-GB": {
                months   : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
                dayOfWeek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            },
            et     : {
                months   : ["Jaanuar", "Veebruar", "Märts", "Aprill", "Mai", "Juuni", "Juuli", "August", "September", "Oktoober", "November", "Detsember"],
                dayOfWeek: ["P", "E", "T", "K", "N", "R", "L"]
            },
            eu     : {
                months   : ["Urtarrila", "Otsaila", "Martxoa", "Apirila", "Maiatza", "Ekaina", "Uztaila", "Abuztua", "Iraila", "Urria", "Azaroa", "Abendua"],
                dayOfWeek: ["Ig.", "Al.", "Ar.", "Az.", "Og.", "Or.", "La."]
            },
            fi     : {
                months   : ["Tammikuu", "Helmikuu", "Maaliskuu", "Huhtikuu", "Toukokuu", "Kesäkuu", "Heinäkuu", "Elokuu", "Syyskuu", "Lokakuu", "Marraskuu", "Joulukuu"],
                dayOfWeek: ["Su", "Ma", "Ti", "Ke", "To", "Pe", "La"]
            },
            gl     : {
                months   : ["Xan", "Feb", "Maz", "Abr", "Mai", "Xun", "Xul", "Ago", "Set", "Out", "Nov", "Dec"],
                dayOfWeek: ["Dom", "Lun", "Mar", "Mer", "Xov", "Ven", "Sab"]
            },
            hr     : {
                months   : ["Sijecanj", "Veljaca", "Ozujak", "Travanj", "Svibanj", "Lipanj", "Srpanj", "Kolovoz", "Rujan", "Listopad", "Studeni", "Prosinac"],
                dayOfWeek: ["Ned", "Pon", "Uto", "Sri", "Cet", "Pet", "Sub"]
            },
            ko     : {
                months   : ["1?", "2?", "3?", "4?", "5?", "6?", "7?", "8?", "9?", "10?", "11?", "12?"],
                dayOfWeek: ["?", "?", "?", "?", "?", "?", "?"]
            },
            lt     : {
                months   : ["Sausio", "Vasario", "Kovo", "Balandzio", "Geguzes", "Birzelio", "Liepos", "Rugpjucio", "Rugsejo", "Spalio", "Lapkricio", "Gruodzio"],
                dayOfWeek: ["Sek", "Pir", "Ant", "Tre", "Ket", "Pen", "Šeš"]
            },
            lv     : {
                months   : ["Janvaris", "Februaris", "Marts", "Aprilis ", "Maijs", "Junijs", "Julijs", "Augusts", "Septembris", "Oktobris", "Novembris", "Decembris"],
                dayOfWeek: ["Sv", "Pr", "Ot", "Tr", "Ct", "Pk", "St"]
            },
            mk     : {
                months   : ["???????", "????????", "????", "?????", "???", "????", "????", "??????", "?????????", "????????", "???????", "????????"],
                dayOfWeek: ["???", "???", "???", "???", "???", "???", "???"]
            },
            mn     : {
                months   : ["1-? ???", "2-? ???", "3-? ???", "4-? ???", "5-? ???", "6-? ???", "7-? ???", "8-? ???", "9-? ???", "10-? ???", "11-? ???", "12-? ???"],
                dayOfWeek: ["???", "???", "???", "???", "???", "???", "???"]
            },
            "pt-BR": {
                months   : ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"],
                dayOfWeek: ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]
            },
            sk     : {
                months   : ["Január", "Február", "Marec", "Apríl", "Máj", "Jún", "Júl", "August", "September", "Október", "November", "December"],
                dayOfWeek: ["Ne", "Po", "Ut", "St", "Št", "Pi", "So"]
            },
            sq     : {
                months   : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
                dayOfWeek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            },
            "sr-YU": {
                months   : ["Januar", "Februar", "Mart", "April", "Maj", "Jun", "Jul", "Avgust", "Septembar", "Oktobar", "Novembar", "Decembar"],
                dayOfWeek: ["Ned", "Pon", "Uto", "Sre", "cet", "Pet", "Sub"]
            },
            sr     : {
                months   : ["??????", "???????", "????", "?????", "???", "???", "???", "??????", "?????????", "???????", "????????", "????????"],
                dayOfWeek: ["???", "???", "???", "???", "???", "???", "???"]
            },
            sv     : {
                months   : ["Januari", "Februari", "Mars", "April", "Maj", "Juni", "Juli", "Augusti", "September", "Oktober", "November", "December"],
                dayOfWeek: ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"]
            },
            "zh-TW": {
                months   : ["??", "??", "??", "??", "??", "??", "??", "??", "??", "??", "???", "???"],
                dayOfWeek: ["?", "?", "?", "?", "?", "?", "?"]
            },
            zh     : {
                months   : ["??", "??", "??", "??", "??", "??", "??", "??", "??", "??", "???", "???"],
                dayOfWeek: ["?", "?", "?", "?", "?", "?", "?"]
            },
            he     : {
                months   : ["?????", "??????", "???", "?????", "???", "????", "????", "??????", "??????", "???????", "??????", "?????"],
                dayOfWeek: ["?'", "?'", "?'", "?'", "?'", "?'", "???"]
            }
        },
        value                 : "",
        lang                  : "en",
        format                : "Y/m/d H:i",
        formatTime            : "H:i",
        formatDate            : "Y/m/d",
        startDate             : !1,
        step                  : 60,
        monthChangeSpinner    : !0,
        closeOnDateSelect     : !1,
        closeOnWithoutClick   : !0,
        closeOnInputClick     : !0,
        timepicker            : !0,
        datepicker            : !0,
        weeks                 : !1,
        defaultTime           : !1,
        defaultDate           : !1,
        minDate               : !1,
        maxDate               : !1,
        minTime               : !1,
        maxTime               : !1,
        allowTimes            : [],
        opened                : !1,
        initTime              : !0,
        inline                : !1,
        theme                 : "",
        onSelectDate          : function(){
        },
        onSelectTime          : function(){
        },
        onChangeMonth         : function(){
        },
        onChangeYear          : function(){
        },
        onChangeDateTime      : function(){
        },
        onShow                : function(){
        },
        onClose               : function(){
        },
        onGenerate            : function(){
        },
        withoutCopyright      : !0,
        inverseButton         : !1,
        hours12               : !1,
        next                  : "xdsoft_next",
        prev                  : "xdsoft_prev",
        dayOfWeekStart        : 0,
        parentID              : "body",
        timeHeightInTimePicker: 25,
        timepickerScrollbar   : !0,
        todayButton           : !0,
        defaultSelect         : !0,
        scrollMonth           : !0,
        scrollTime            : !0,
        scrollInput           : !0,
        lazyInit              : !1,
        mask                  : !1,
        validateOnBlur        : !0,
        allowBlank            : !0,
        yearStart             : 1950,
        yearEnd               : 2050,
        style                 : "",
        id                    : "",
        fixed                 : !1,
        roundTime             : "round",
        className             : "",
        weekends              : [],
        disabledDates         : [],
        yearOffset            : 0,
        beforeShowDay         : null,
        enterLikeTab          : !0
    };
    Array.prototype.indexOf || (Array.prototype.indexOf = function(e, t){
        var n, a;
        for(n = t || 0, a = this.length ; a > n ; n += 1) if(this[n] === e) return n;
        return -1
    }), Date.prototype.countDaysInMonth = function(){
        return new Date(this.getFullYear(), this.getMonth() + 1, 0).getDate()
    }, e.fn.xdsoftScroller = function(t){
        return this.each(function(){
            var n, a, r, o, s, i = e(this), u = function(e){
                var t, n = {x: 0, y: 0};
                return "touchstart" === e.type || "touchmove" === e.type || "touchend" === e.type || "touchcancel" === e.type? (t = e.originalEvent.touches[0] || e.originalEvent.changedTouches[0], n.x = t.clientX, n.y = t.clientY) : ("mousedown" === e.type || "mouseup" === e.type || "mousemove" === e.type || "mouseover" === e.type || "mouseout" === e.type || "mouseenter" === e.type || "mouseleave" === e.type) && (n.x = e.clientX, n.y = e.clientY), n
            }, d = 100, l = !1, c = 0, f = 0, m = 0, h = !1, g = 0, p = function(){
            };
            return "hide" === t? void i.find(".xdsoft_scrollbar").hide() : (e(this).hasClass("xdsoft_scroller_box") || (n = i.children().eq(0), a = i[0].clientHeight, r = n[0].offsetHeight, o = e('<div class="xdsoft_scrollbar"></div>'), s = e('<div class="xdsoft_scroller"></div>'), o.append(s), i.addClass("xdsoft_scroller_box").append(o), p = function(e){
                var t = u(e).y - c + g;
                0 > t && (t = 0), t + s[0].offsetHeight > m && (t = m - s[0].offsetHeight), i.trigger("scroll_element.xdsoft_scroller", [d? t / d : 0])
            }, s.on("touchstart.xdsoft_scroller mousedown.xdsoft_scroller", function(n){
                a || i.trigger("resize_scroll.xdsoft_scroller", [t]), c = u(n).y, g = parseInt(s.css("margin-top"), 10), m = o[0].offsetHeight, "mousedown" === n.type? (document && e(document.body).addClass("xdsoft_noselect"), e([document.body, window]).on("mouseup.xdsoft_scroller", function r(){
                    e([document.body, window]).off("mouseup.xdsoft_scroller", r).off("mousemove.xdsoft_scroller", p).removeClass("xdsoft_noselect")
                }), e(document.body).on("mousemove.xdsoft_scroller", p)) : (h = !0, n.stopPropagation(), n.preventDefault())
            }).on("touchmove", function(e){
                h && (e.preventDefault(), p(e))
            }).on("touchend touchcancel", function(){
                h = !1, g = 0
            }), i.on("scroll_element.xdsoft_scroller", function(e, t){
                a || i.trigger("resize_scroll.xdsoft_scroller", [t, !0]), t = t > 1? 1 : 0 > t || isNaN(t)? 0 : t, s.css("margin-top", d * t), setTimeout(function(){
                    n.css("marginTop", -parseInt((n[0].offsetHeight - a) * t, 10))
                }, 10)
            }).on("resize_scroll.xdsoft_scroller", function(e, t, u){
                var l, c;
                a = i[0].clientHeight, r = n[0].offsetHeight, l = a / r, c = l * o[0].offsetHeight, l > 1? s.hide() : (s.show(), s.css("height", parseInt(c > 10? c : 10, 10)), d = o[0].offsetHeight - s[0].offsetHeight, u !== !0 && i.trigger("scroll_element.xdsoft_scroller", [t || Math.abs(parseInt(n.css("marginTop"), 10)) / (r - a)]))
            }), i.on("mousewheel", function(e){
                var t = Math.abs(parseInt(n.css("marginTop"), 10));
                return t -= 20 * e.deltaY, 0 > t && (t = 0), i.trigger("scroll_element.xdsoft_scroller", [t / (r - a)]), e.stopPropagation(), !1
            }), i.on("touchstart", function(e){
                l = u(e), f = Math.abs(parseInt(n.css("marginTop"), 10))
            }), i.on("touchmove", function(e){
                if(l)
                {
                    e.preventDefault();
                    var t = u(e);
                    i.trigger("scroll_element.xdsoft_scroller", [(f - (t.y - l.y)) / (r - a)])
                }
            }), i.on("touchend touchcancel", function(){
                l = !1, f = 0
            })), void i.trigger("resize_scroll.xdsoft_scroller", [t]))
        })
    }, e.fn.datetimepicker = function(n){
        var a, r, o = 48, s = 57, i = 96, u = 105, d = 17, l = 46, c = 13, f = 27, m = 8, h = 37, g = 38, p = 39,
            x = 40, D = 9, y = 116, v = 65, b = 67, T = 86, k = 90, w = 89, M = !1,
            S = e.isPlainObject(n) || !n? e.extend(!0, {}, t, n) : e.extend(!0, {}, t), O = 0, _ = function(e){
                e.on("open.xdsoft focusin.xdsoft mousedown.xdsoft", function t(){
                    e.is(":disabled") || e.data("xdsoft_datetimepicker") || (clearTimeout(O), O = setTimeout(function(){
                        e.data("xdsoft_datetimepicker") || a(e), e.off("open.xdsoft focusin.xdsoft mousedown.xdsoft", t).trigger("open.xdsoft")
                    }, 100))
                })
            };
        return a = function(t){
            function a()
            {
                var e, n = !1;
                return S.startDate? n = Y.strToDate(S.startDate) : (n = S.value || (t && t.val && t.val()? t.val() : ""), n? n = Y.strToDateTime(n) : S.defaultDate && (n = Y.strToDate(S.defaultDate), S.defaultTime && (e = Y.strtotime(S.defaultTime), n.setHours(e.getHours()), n.setMinutes(e.getMinutes())))), n && Y.isValidDate(n)? W.data("changed", !0) : n = "", n || 0
            }

            var r, O, _, F, A, Y,
                W = e("<div " + (S.id? 'id="' + S.id + '"' : "") + " " + (S.style? 'style="' + S.style + '"' : "") + ' class="xdsoft_datetimepicker xdsoft_' + S.theme + " xdsoft_noselect " + (S.weeks? " xdsoft_showweeks" : "") + S.className + '"></div>'),
                C = e('<div class="xdsoft_copyright"><a target="_blank" href="http://xdsoft.net/jqplugins/datetimepicker/">xdsoft.net</a></div>'),
                J = e('<div class="xdsoft_datepicker active"></div>'),
                P = e('<div class="xdsoft_mounthpicker"><button type="button" class="xdsoft_prev"></button><button type="button" class="xdsoft_today_button"></button><div class="xdsoft_label xdsoft_month"><span></span><i></i></div><div class="xdsoft_label xdsoft_year"><span></span><i></i></div><button type="button" class="xdsoft_next"></button></div>'),
                I = e('<div class="xdsoft_calendar"></div>'),
                N = e('<div class="xdsoft_timepicker active"><button type="button" class="xdsoft_prev"></button><div class="xdsoft_time_box"></div><button type="button" class="xdsoft_next"></button></div>'),
                H = N.find(".xdsoft_time_box").eq(0), z = e('<div class="xdsoft_time_variant"></div>'),
                j = e('<div class="xdsoft_select xdsoft_monthselect"><div></div></div>'),
                L = e('<div class="xdsoft_select xdsoft_yearselect"><div></div></div>'), R = !1, B = 0, V = 0;
            P.find(".xdsoft_month span").after(j), P.find(".xdsoft_year span").after(L), P.find(".xdsoft_month,.xdsoft_year").on("mousedown.xdsoft", function(t){
                var n, a, r = e(this).find(".xdsoft_select").eq(0), o = 0, s = 0, i = r.is(":visible");
                for(P.find(".xdsoft_select").hide(), Y.currentTime && (o = Y.currentTime[e(this).hasClass("xdsoft_month")? "getMonth" : "getFullYear"]()), r[i? "hide" : "show"](), n = r.find("div.xdsoft_option"), a = 0 ; a < n.length && n.eq(a).data("value") !== o ; a += 1) s += n[0].offsetHeight;
                return r.xdsoftScroller(s / (r.children()[0].offsetHeight - r[0].clientHeight)), t.stopPropagation(), !1
            }), P.find(".xdsoft_select").xdsoftScroller().on("mousedown.xdsoft", function(e){
                e.stopPropagation(), e.preventDefault()
            }).on("mousedown.xdsoft", ".xdsoft_option", function(){
                var t = Y.currentTime.getFullYear();
                Y && Y.currentTime && Y.currentTime[e(this).parent().parent().hasClass("xdsoft_monthselect")? "setMonth" : "setFullYear"](e(this).data("value")), e(this).parent().parent().hide(), W.trigger("xchange.xdsoft"), S.onChangeMonth && e.isFunction(S.onChangeMonth) && S.onChangeMonth.call(W, Y.currentTime, W.data("input")), t !== Y.currentTime.getFullYear() && e.isFunction(S.onChangeYear) && S.onChangeYear.call(W, Y.currentTime, W.data("input"))
            }), W.setOptions = function(n){
                if(S = e.extend(!0, {}, S, n), n.allowTimes && e.isArray(n.allowTimes) && n.allowTimes.length && (S.allowTimes = e.extend(!0, [], n.allowTimes)), n.weekends && e.isArray(n.weekends) && n.weekends.length && (S.weekends = e.extend(!0, [], n.weekends)), n.disabledDates && e.isArray(n.disabledDates) && n.disabledDates.length && (S.disabledDates = e.extend(!0, [], n.disabledDates)), !S.open && !S.opened || S.inline || t.trigger("open.xdsoft"), S.inline && (R = !0, W.addClass("xdsoft_inline"), t.after(W).hide()), S.inverseButton && (S.next = "xdsoft_prev", S.prev = "xdsoft_next"), S.datepicker? J.addClass("active") : J.removeClass("active"), S.timepicker? N.addClass("active") : N.removeClass("active"), S.value && (t && t.val && t.val(S.value), Y.setCurrentTime(S.value)), S.dayOfWeekStart = isNaN(S.dayOfWeekStart)? 0 : parseInt(S.dayOfWeekStart, 10) % 7, S.timepickerScrollbar || H.xdsoftScroller("hide"), S.minDate && /^-(.*)$/.test(S.minDate) && (S.minDate = Y.strToDateTime(S.minDate).dateFormat(S.formatDate)), S.maxDate && /^\+(.*)$/.test(S.maxDate) && (S.maxDate = Y.strToDateTime(S.maxDate).dateFormat(S.formatDate)), P.find(".xdsoft_today_button").css("visibility", S.todayButton? "visible" : "hidden"), S.mask)
                {
                    var a = function(e){
                        try
                        {
                            if(document.selection && document.selection.createRange)
                            {
                                var t = document.selection.createRange();
                                return t.getBookmark().charCodeAt(2) - 2
                            }
                            if(e.setSelectionRange) return e.selectionStart
                        }
                        catch(n)
                        {
                            return 0
                        }
                    }, r = function(e, t){
                        if(e = "string" == typeof e || e instanceof String? document.getElementById(e) : e, !e) return !1;
                        if(e.createTextRange)
                        {
                            var n = e.createTextRange();
                            return n.collapse(!0), n.moveEnd("character", t), n.moveStart("character", t), n.select(), !0
                        }
                        return e.setSelectionRange? (e.setSelectionRange(t, t), !0) : !1
                    }, O = function(e, t){
                        var n = e.replace(/([\[\]\/\{\}\(\)\-\.\+]{1})/g, "\\$1").replace(/_/g, "{digit+}").replace(/([0-9]{1})/g, "{digit$1}").replace(/\{digit([0-9]{1})\}/g, "[0-$1_]{1}").replace(/\{digit[\+]\}/g, "[0-9_]{1}");
                        return new RegExp(n).test(t)
                    };
                    t.off("keydown.xdsoft"), S.mask === !0 && (S.mask = S.format.replace(/Y/g, "9999").replace(/F/g, "9999").replace(/m/g, "19").replace(/d/g, "39").replace(/H/g, "29").replace(/i/g, "59").replace(/s/g, "59")), "string" === e.type(S.mask) && (O(S.mask, t.val()) || t.val(S.mask.replace(/[0-9]/g, "_")), t.on("keydown.xdsoft", function(n){
                        var _, F, A = this.value, Y = n.which;
                        if(Y >= o && s >= Y || Y >= i && u >= Y || Y === m || Y === l)
                        {
                            for(_ = a(this), F = Y !== m && Y !== l? String.fromCharCode(Y >= i && u >= Y? Y - o : Y) : "_", Y !== m && Y !== l || !_ || (_ -= 1, F = "_") ; /[^0-9_]/.test(S.mask.substr(_, 1)) && _ < S.mask.length && _ > 0 ;) _ += Y === m || Y === l? -1 : 1;
                            if(A = A.substr(0, _) + F + A.substr(_ + 1), "" === e.trim(A)) A = S.mask.replace(/[0-9]/g, "_");
                            else if(_ === S.mask.length) return n.preventDefault(), !1;
                            for(_ += Y === m || Y === l? 0 : 1 ; /[^0-9_]/.test(S.mask.substr(_, 1)) && _ < S.mask.length && _ > 0 ;) _ += Y === m || Y === l? -1 : 1;
                            O(S.mask, A)? (this.value = A, r(this, _)) : "" === e.trim(A)? this.value = S.mask.replace(/[0-9]/g, "_") : t.trigger("error_input.xdsoft")
                        }
                        else if(-1 !== [v, b, T, k, w].indexOf(Y) && M || -1 !== [f, g, x, h, p, y, d, D, c].indexOf(Y)) return !0;
                        return n.preventDefault(), !1
                    }))
                }
                S.validateOnBlur && t.off("blur.xdsoft").on("blur.xdsoft", function(){
                    S.allowBlank && !e.trim(e(this).val()).length? (e(this).val(null), W.data("xdsoft_datetime").empty()) : Date.parseDate(e(this).val(), S.format)? W.data("xdsoft_datetime").setCurrentTime(e(this).val()) : (e(this).val(Y.now().dateFormat(S.format)), W.data("xdsoft_datetime").setCurrentTime(e(this).val())), W.trigger("changedatetime.xdsoft")
                }), S.dayOfWeekStartPrev = 0 === S.dayOfWeekStart? 6 : S.dayOfWeekStart - 1, W.trigger("xchange.xdsoft").trigger("afterOpen.xdsoft")
            }, W.data("options", S).on("mousedown.xdsoft", function(e){
                return e.stopPropagation(), e.preventDefault(), L.hide(), j.hide(), !1
            }), H.append(z), H.xdsoftScroller(), W.on("afterOpen.xdsoft", function(){
                H.xdsoftScroller()
            }), W.append(J).append(N), S.withoutCopyright !== !0 && W.append(C), J.append(P).append(I), e(S.parentID).append(W), r = function(){
                var t = this;
                t.now = function(e){
                    var n, a, r = new Date;
                    return !e && S.defaultDate && (n = t.strToDate(S.defaultDate), r.setFullYear(n.getFullYear()), r.setMonth(n.getMonth()), r.setDate(n.getDate())), S.yearOffset && r.setFullYear(r.getFullYear() + S.yearOffset), !e && S.defaultTime && (a = t.strtotime(S.defaultTime), r.setHours(a.getHours()), r.setMinutes(a.getMinutes())), r
                }, t.isValidDate = function(e){
                    return "[object Date]" !== Object.prototype.toString.call(e)? !1 : !isNaN(e.getTime())
                }, t.setCurrentTime = function(e){
                    t.currentTime = "string" == typeof e? t.strToDateTime(e) : t.isValidDate(e)? e : t.now(), W.trigger("xchange.xdsoft")
                }, t.empty = function(){
                    t.currentTime = null
                }, t.getCurrentTime = function(){
                    return t.currentTime
                }, t.nextMonth = function(){
                    var n, a = t.currentTime.getMonth() + 1;
                    return 12 === a && (t.currentTime.setFullYear(t.currentTime.getFullYear() + 1), a = 0), n = t.currentTime.getFullYear(), t.currentTime.setDate(Math.min(new Date(t.currentTime.getFullYear(), a + 1, 0).getDate(), t.currentTime.getDate())), t.currentTime.setMonth(a), S.onChangeMonth && e.isFunction(S.onChangeMonth) && S.onChangeMonth.call(W, Y.currentTime, W.data("input")), n !== t.currentTime.getFullYear() && e.isFunction(S.onChangeYear) && S.onChangeYear.call(W, Y.currentTime, W.data("input")), W.trigger("xchange.xdsoft"), a
                }, t.prevMonth = function(){
                    var n = t.currentTime.getMonth() - 1;
                    return -1 === n && (t.currentTime.setFullYear(t.currentTime.getFullYear() - 1), n = 11), t.currentTime.setDate(Math.min(new Date(t.currentTime.getFullYear(), n + 1, 0).getDate(), t.currentTime.getDate())), t.currentTime.setMonth(n), S.onChangeMonth && e.isFunction(S.onChangeMonth) && S.onChangeMonth.call(W, Y.currentTime, W.data("input")), W.trigger("xchange.xdsoft"), n
                }, t.getWeekOfYear = function(e){
                    var t = new Date(e.getFullYear(), 0, 1);
                    return Math.ceil(((e - t) / 864e5 + t.getDay() + 1) / 7)
                }, t.strToDateTime = function(e){
                    var n, a, r = [];
                    return e && e instanceof Date && t.isValidDate(e)? e : (r = /^(\+|\-)(.*)$/.exec(e), r && (r[2] = Date.parseDate(r[2], S.formatDate)), r && r[2]? (n = r[2].getTime() - 6e4 * r[2].getTimezoneOffset(), a = new Date(Y.now().getTime() + parseInt(r[1] + "1", 10) * n)) : a = e? Date.parseDate(e, S.format) : t.now(), t.isValidDate(a) || (a = t.now()), a)
                }, t.strToDate = function(e){
                    if(e && e instanceof Date && t.isValidDate(e)) return e;
                    var n = e? Date.parseDate(e, S.formatDate) : t.now(!0);
                    return t.isValidDate(n) || (n = t.now(!0)), n
                }, t.strtotime = function(e){
                    if(e && e instanceof Date && t.isValidDate(e)) return e;
                    var n = e? Date.parseDate(e, S.formatTime) : t.now(!0);
                    return t.isValidDate(n) || (n = t.now(!0)), n
                }, t.str = function(){
                    return t.currentTime.dateFormat(S.format)
                }, t.currentTime = this.now()
            }, Y = new r, P.find(".xdsoft_today_button").on("mousedown.xdsoft", function(){
                W.data("changed", !0), Y.setCurrentTime(0), W.trigger("afterOpen.xdsoft")
            }).on("dblclick.xdsoft", function(){
                t.val(Y.str()), W.trigger("close.xdsoft")
            }), P.find(".xdsoft_prev,.xdsoft_next").on("mousedown.xdsoft", function(){
                var t = e(this), n = 0, a = !1;
                !function r(e){
                    Y.currentTime.getMonth();
                    t.hasClass(S.next)? Y.nextMonth() : t.hasClass(S.prev) && Y.prevMonth(), S.monthChangeSpinner && (a || (n = setTimeout(r, e || 100)))
                }(500), e([document.body, window]).on("mouseup.xdsoft", function o(){
                    clearTimeout(n), a = !0, e([document.body, window]).off("mouseup.xdsoft", o)
                })
            }), N.find(".xdsoft_prev,.xdsoft_next").on("mousedown.xdsoft", function(){
                var t = e(this), n = 0, a = !1, r = 110;
                !function o(e){
                    var s = H[0].clientHeight, i = z[0].offsetHeight, u = Math.abs(parseInt(z.css("marginTop"), 10));
                    t.hasClass(S.next) && i - s - S.timeHeightInTimePicker >= u? z.css("marginTop", "-" + (u + S.timeHeightInTimePicker) + "px") : t.hasClass(S.prev) && u - S.timeHeightInTimePicker >= 0 && z.css("marginTop", "-" + (u - S.timeHeightInTimePicker) + "px"), H.trigger("scroll_element.xdsoft_scroller", [Math.abs(parseInt(z.css("marginTop"), 10) / (i - s))]), r = r > 10? 10 : r - 10, a || (n = setTimeout(o, e || r))
                }(500), e([document.body, window]).on("mouseup.xdsoft", function s(){
                    clearTimeout(n), a = !0, e([document.body, window]).off("mouseup.xdsoft", s)
                })
            }), O = 0, W.on("xchange.xdsoft", function(t){
                clearTimeout(O), O = setTimeout(function(){
                    for(var t, a, r, o, s, i, u, d = "", l = new Date(Y.currentTime.getFullYear(), Y.currentTime.getMonth(), 1, 12, 0, 0), c = 0, f = Y.now(), m = !1, h = !1, g = [], p = !0, x = "", D = "" ; l.getDay() !== S.dayOfWeekStart ;) l.setDate(l.getDate() - 1);
                    for(d += "<table><thead><tr>", S.weeks && (d += "<th></th>"), t = 0 ; 7 > t ; t += 1) d += "<th>" + S.i18n[S.lang].dayOfWeek[(t + S.dayOfWeekStart) % 7] + "</th>";
                    for(d += "</tr></thead>", d += "<tbody>", S.maxDate !== !1 && (m = Y.strToDate(S.maxDate), m = new Date(m.getFullYear(), m.getMonth(), m.getDate(), 23, 59, 59, 999)), S.minDate !== !1 && (h = Y.strToDate(S.minDate), h = new Date(h.getFullYear(), h.getMonth(), h.getDate())) ; c < Y.currentTime.countDaysInMonth() || l.getDay() !== S.dayOfWeekStart || Y.currentTime.getMonth() === l.getMonth() ;) g = [], c += 1, a = l.getDate(), r = l.getFullYear(), o = l.getMonth(), s = Y.getWeekOfYear(l), g.push("xdsoft_date"), i = S.beforeShowDay && e.isFunction(S.beforeShowDay.call)? S.beforeShowDay.call(W, l) : null, m !== !1 && l > m || h !== !1 && h > l || i && i[0] === !1? g.push("xdsoft_disabled") : -1 !== S.disabledDates.indexOf(l.dateFormat(S.formatDate)) && g.push("xdsoft_disabled"), i && "" !== i[1] && g.push(i[1]), Y.currentTime.getMonth() !== o && g.push("xdsoft_other_month"), (S.defaultSelect || W.data("changed")) && Y.currentTime.dateFormat(S.formatDate) === l.dateFormat(S.formatDate) && g.push("xdsoft_current"), f.dateFormat(S.formatDate) === l.dateFormat(S.formatDate) && g.push("xdsoft_today"), (0 === l.getDay() || 6 === l.getDay() || ~S.weekends.indexOf(l.dateFormat(S.formatDate))) && g.push("xdsoft_weekend"), S.beforeShowDay && e.isFunction(S.beforeShowDay) && g.push(S.beforeShowDay(l)), p && (d += "<tr>", p = !1, S.weeks && (d += "<th>" + s + "</th>")), d += '<td data-date="' + a + '" data-month="' + o + '" data-year="' + r + '" class="xdsoft_date xdsoft_day_of_week' + l.getDay() + " " + g.join(" ") + '"><div>' + a + "</div></td>", l.getDay() === S.dayOfWeekStartPrev && (d += "</tr>", p = !0), l.setDate(a + 1);
                    if(d += "</tbody></table>", I.html(d), P.find(".xdsoft_label span").eq(0).text(S.i18n[S.lang].months[Y.currentTime.getMonth()]), P.find(".xdsoft_label span").eq(1).text(Y.currentTime.getFullYear()), x = "", D = "", o = "", u = function(e, t){
                            var n = Y.now();
                            n.setHours(e), e = parseInt(n.getHours(), 10), n.setMinutes(t), t = parseInt(n.getMinutes(), 10);
                            var a = new Date(Y.currentTime);
                            a.setHours(e), a.setMinutes(t), g = [], (S.minDateTime !== !1 && S.minDateTime > a || S.maxTime !== !1 && Y.strtotime(S.maxTime).getTime() < n.getTime() || S.minTime !== !1 && Y.strtotime(S.minTime).getTime() > n.getTime()) && g.push("xdsoft_disabled"), (S.initTime || S.defaultSelect || W.data("changed")) && parseInt(Y.currentTime.getHours(), 10) === parseInt(e, 10) && (S.step > 59 || Math[S.roundTime](Y.currentTime.getMinutes() / S.step) * S.step === parseInt(t, 10)) && (S.defaultSelect || W.data("changed")? g.push("xdsoft_current") : S.initTime && g.push("xdsoft_init_time")), parseInt(f.getHours(), 10) === parseInt(e, 10) && parseInt(f.getMinutes(), 10) === parseInt(t, 10) && g.push("xdsoft_today"), x += '<div class="xdsoft_time ' + g.join(" ") + '" data-hour="' + e + '" data-minute="' + t + '">' + n.dateFormat(S.formatTime) + "</div>"
                        }, S.allowTimes && e.isArray(S.allowTimes) && S.allowTimes.length) for(c = 0 ; c < S.allowTimes.length ; c += 1) D = Y.strtotime(S.allowTimes[c]).getHours(), o = Y.strtotime(S.allowTimes[c]).getMinutes(), u(D, o);
                    else for(c = 0, t = 0 ; c < (S.hours12? 12 : 24) ; c += 1) for(t = 0 ; 60 > t ; t += S.step) D = (10 > c? "0" : "") + c, o = (10 > t? "0" : "") + t, u(D, o);
                    for(z.html(x), n = "", c = 0, c = parseInt(S.yearStart, 10) + S.yearOffset ; c <= parseInt(S.yearEnd, 10) + S.yearOffset ; c += 1) n += '<div class="xdsoft_option ' + (Y.currentTime.getFullYear() === c? "xdsoft_current" : "") + '" data-value="' + c + '">' + c + "</div>";
                    for(L.children().eq(0).html(n), c = 0, n = "" ; 11 >= c ; c += 1) n += '<div class="xdsoft_option ' + (Y.currentTime.getMonth() === c? "xdsoft_current" : "") + '" data-value="' + c + '">' + S.i18n[S.lang].months[c] + "</div>";
                    j.children().eq(0).html(n), e(W).trigger("generate.xdsoft")
                }, 10), t.stopPropagation()
            }).on("afterOpen.xdsoft", function(){
                if(S.timepicker)
                {
                    var e, t, n, a;
                    z.find(".xdsoft_current").length? e = ".xdsoft_current" : z.find(".xdsoft_init_time").length && (e = ".xdsoft_init_time"), e? (t = H[0].clientHeight, n = z[0].offsetHeight, a = z.find(e).index() * S.timeHeightInTimePicker + 1, a > n - t && (a = n - t), H.trigger("scroll_element.xdsoft_scroller", [parseInt(a, 10) / (n - t)])) : H.trigger("scroll_element.xdsoft_scroller", [0])
                }
            }), _ = 0, I.on("click.xdsoft", "td", function(n){
                n.stopPropagation(), _ += 1;
                var a = e(this), r = Y.currentTime;
                return (void 0 === r || null === r) && (Y.currentTime = Y.now(), r = Y.currentTime), a.hasClass("xdsoft_disabled")? !1 : (r.setDate(1), r.setFullYear(a.data("year")), r.setMonth(a.data("month")), r.setDate(a.data("date")), W.trigger("select.xdsoft", [r]), t.val(Y.str()), (_ > 1 || S.closeOnDateSelect === !0 || 0 === S.closeOnDateSelect && !S.timepicker) && !S.inline && W.trigger("close.xdsoft"), S.onSelectDate && e.isFunction(S.onSelectDate) && S.onSelectDate.call(W, Y.currentTime, W.data("input"), n), W.data("changed", !0), W.trigger("xchange.xdsoft"), W.trigger("changedatetime.xdsoft"), void setTimeout(function(){
                    _ = 0
                }, 200))
            }), z.on("click.xdsoft", "div", function(t){
                t.stopPropagation();
                var n = e(this), a = Y.currentTime;
                return (void 0 === a || null === a) && (Y.currentTime = Y.now(), a = Y.currentTime), n.hasClass("xdsoft_disabled")? !1 : (a.setHours(n.data("hour")), a.setMinutes(n.data("minute")), W.trigger("select.xdsoft", [a]), W.data("input").val(Y.str()), S.inline || W.trigger("close.xdsoft"), S.onSelectTime && e.isFunction(S.onSelectTime) && S.onSelectTime.call(W, Y.currentTime, W.data("input"), t), W.data("changed", !0), W.trigger("xchange.xdsoft"), void W.trigger("changedatetime.xdsoft"))
            }), J.on("mousewheel.xdsoft", function(e){
                return S.scrollMonth? (e.deltaY < 0? Y.nextMonth() : Y.prevMonth(), !1) : !0
            }), t.on("mousewheel.xdsoft", function(e){
                return S.scrollInput? !S.datepicker && S.timepicker? (F = z.find(".xdsoft_current").length? z.find(".xdsoft_current").eq(0).index() : 0, F + e.deltaY >= 0 && F + e.deltaY < z.children().length && (F += e.deltaY), z.children().eq(F).length && z.children().eq(F).trigger("mousedown"), !1) : S.datepicker && !S.timepicker? (J.trigger(e, [e.deltaY, e.deltaX, e.deltaY]), t.val && t.val(Y.str()), W.trigger("changedatetime.xdsoft"), !1) : void 0 : !0
            }), W.on("changedatetime.xdsoft", function(t){
                if(S.onChangeDateTime && e.isFunction(S.onChangeDateTime))
                {
                    var n = W.data("input");
                    S.onChangeDateTime.call(W, Y.currentTime, n, t), delete S.value, n.trigger("change")
                }
            }).on("generate.xdsoft", function(){
                S.onGenerate && e.isFunction(S.onGenerate) && S.onGenerate.call(W, Y.currentTime, W.data("input")), R && (W.trigger("afterOpen.xdsoft"), R = !1)
            }).on("click.xdsoft", function(e){
                e.stopPropagation()
            }), F = 0, A = function(){
                var t = W.data("input").offset(), n = t.top + W.data("input")[0].offsetHeight - 1, a = t.left,
                    r = "absolute";
                S.fixed? (n -= e(window).scrollTop(), a -= e(window).scrollLeft(), r = "fixed") : (n + W[0].offsetHeight > e(window).height() + e(window).scrollTop() && (n = t.top - W[0].offsetHeight + 1), 0 > n && (n = 0), a + W[0].offsetWidth > e(window).width() && (a = e(window).width() - W[0].offsetWidth)), W.css({
                    left    : a,
                    top     : n,
                    position: r
                })
            }, W.on("open.xdsoft", function(t){
                var n = !0;
                S.onShow && e.isFunction(S.onShow) && (n = S.onShow.call(W, Y.currentTime, W.data("input"), t)), n !== !1 && (W.show(), A(), e(window).off("resize.xdsoft", A).on("resize.xdsoft", A), S.closeOnWithoutClick && e([document.body, window]).on("mousedown.xdsoft", function a(){
                    W.trigger("close.xdsoft"), e([document.body, window]).off("mousedown.xdsoft", a)
                }))
            }).on("close.xdsoft", function(t){
                var n = !0;
                P.find(".xdsoft_month,.xdsoft_year").find(".xdsoft_select").hide(), S.onClose && e.isFunction(S.onClose) && (n = S.onClose.call(W, Y.currentTime, W.data("input"), t)), n === !1 || S.opened || S.inline || W.hide(), t.stopPropagation()
            }).on("toggle.xdsoft", function(){
                W.trigger(W.is(":visible")? "close.xdsoft" : "open.xdsoft")
            }).data("input", t), B = 0, V = 0, W.data("xdsoft_datetime", Y), W.setOptions(S), Y.setCurrentTime(a()), t.data("xdsoft_datetimepicker", W).on("open.xdsoft focusin.xdsoft mousedown.xdsoft", function(){
                t.is(":disabled") || t.data("xdsoft_datetimepicker").is(":visible") && S.closeOnInputClick || (clearTimeout(B), B = setTimeout(function(){
                    t.is(":disabled") || (R = !0, Y.setCurrentTime(a()), W.trigger("open.xdsoft"))
                }, 100))
            }).on("keydown.xdsoft", function(t){
                var n, a = (this.value, t.which);
                return -1 !== [c].indexOf(a) && S.enterLikeTab? (n = e("input:visible,textarea:visible"), W.trigger("close.xdsoft"), n.eq(n.index(this) + 1).focus(), !1) : -1 !== [D].indexOf(a)? (W.trigger("close.xdsoft"), !0) : void 0
            })
        }, r = function(t){
            var n = t.data("xdsoft_datetimepicker");
            n && (n.data("xdsoft_datetime", null), n.remove(), t.data("xdsoft_datetimepicker", null).off(".xdsoft"), e(window).off("resize.xdsoft"), e([window, document.body]).off("mousedown.xdsoft"), t.unmousewheel && t.unmousewheel())
        }, e(document).off("keydown.xdsoftctrl keyup.xdsoftctrl").on("keydown.xdsoftctrl", function(e){
            e.keyCode === d && (M = !0)
        }).on("keyup.xdsoftctrl", function(e){
            e.keyCode === d && (M = !1)
        }), this.each(function(){
            var t = e(this).data("xdsoft_datetimepicker");
            if(t)
            {
                if("string" === e.type(n)) switch(n)
                {
                    case"show":
                        e(this).select().focus(), t.trigger("open.xdsoft");
                        break;
                    case"hide":
                        t.trigger("close.xdsoft");
                        break;
                    case"toggle":
                        t.trigger("toggle.xdsoft");
                        break;
                    case"destroy":
                        r(e(this));
                        break;
                    case"reset":
                        this.value = this.defaultValue, this.value && t.data("xdsoft_datetime").isValidDate(Date.parseDate(this.value, S.format)) || t.data("changed", !1), t.data("xdsoft_datetime").setCurrentTime(this.value)
                }
                else t.setOptions(n);
                return 0
            }
            "string" !== e.type(n) && (!S.lazyInit || S.open || S.inline? a(e(this)) : _(e(this)))
        })
    }, e.fn.datetimepicker.defaults = t
}(jQuery), function(){
    !function(e){
        "function" == typeof define && define.amd? define(["jquery"], e) : "object" == typeof exports? module.exports = e : e(jQuery)
    }(function(e){
        function t(t)
        {
            var s = t || window.event, i = u.call(arguments, 1), d = 0, c = 0, f = 0, m = 0, h = 0, g = 0;
            if(t = e.event.fix(s), t.type = "mousewheel", "detail" in s && (f = -1 * s.detail), "wheelDelta" in s && (f = s.wheelDelta), "wheelDeltaY" in s && (f = s.wheelDeltaY), "wheelDeltaX" in s && (c = -1 * s.wheelDeltaX), "axis" in s && s.axis === s.HORIZONTAL_AXIS && (c = -1 * f, f = 0), d = 0 === f? c : f, "deltaY" in s && (f = -1 * s.deltaY, d = f), "deltaX" in s && (c = s.deltaX, 0 === f && (d = -1 * c)), 0 !== f || 0 !== c)
            {
                if(1 === s.deltaMode)
                {
                    var p = e.data(this, "mousewheel-line-height");
                    d *= p, f *= p, c *= p
                }
                else if(2 === s.deltaMode)
                {
                    var x = e.data(this, "mousewheel-page-height");
                    d *= x, f *= x, c *= x
                }
                if(m = Math.max(Math.abs(f), Math.abs(c)), (!o || o > m) && (o = m, a(s, m) && (o /= 40)), a(s, m) && (d /= 40, c /= 40, f /= 40), d = Math[d >= 1? "floor" : "ceil"](d / o), c = Math[c >= 1? "floor" : "ceil"](c / o), f = Math[f >= 1? "floor" : "ceil"](f / o), l.settings.normalizeOffset && this.getBoundingClientRect)
                {
                    var D = this.getBoundingClientRect();
                    h = t.clientX - D.left, g = t.clientY - D.top
                }
                return t.deltaX = c, t.deltaY = f, t.deltaFactor = o, t.offsetX = h, t.offsetY = g, t.deltaMode = 0, i.unshift(t, d, c, f), r && clearTimeout(r), r = setTimeout(n, 200), (e.event.dispatch || e.event.handle).apply(this, i)
            }
        }

        function n()
        {
            o = null
        }

        function a(e, t)
        {
            return l.settings.adjustOldDeltas && "mousewheel" === e.type && t % 120 === 0
        }

        var r, o, s = ["wheel", "mousewheel", "DOMMouseScroll", "MozMousePixelScroll"],
            i = "onwheel" in document || document.documentMode >= 9? ["wheel"] : ["mousewheel", "DomMouseScroll", "MozMousePixelScroll"],
            u = Array.prototype.slice;
        if(e.event.fixHooks) for(var d = s.length ; d ;) e.event.fixHooks[s[--d]] = e.event.mouseHooks;
        var l = e.event.special.mousewheel = {
            version         : "3.1.12", setup: function(){
                if(this.addEventListener) for(var n = i.length ; n ;) this.addEventListener(i[--n], t, !1);
                else this.onmousewheel = t;
                e.data(this, "mousewheel-line-height", l.getLineHeight(this)), e.data(this, "mousewheel-page-height", l.getPageHeight(this))
            }, teardown     : function(){
                if(this.removeEventListener) for(var n = i.length ; n ;) this.removeEventListener(i[--n], t, !1);
                else this.onmousewheel = null;
                e.removeData(this, "mousewheel-line-height"), e.removeData(this, "mousewheel-page-height")
            }, getLineHeight: function(t){
                var n = e(t), a = n["offsetParent" in e.fn? "offsetParent" : "parent"]();
                return a.length || (a = e("body")), parseInt(a.css("fontSize"), 10) || parseInt(n.css("fontSize"), 10) || 16
            }, getPageHeight: function(t){
                return e(t).height()
            }, settings     : {adjustOldDeltas: !0, normalizeOffset: !0}
        };
        e.fn.extend({
            mousewheel     : function(e){
                return e? this.bind("mousewheel", e) : this.trigger("mousewheel")
            }, unmousewheel: function(e){
                return this.unbind("mousewheel", e)
            }
        })
    }), Date.parseFunctions = {count: 0}, Date.parseRegexes = [], Date.formatFunctions = {count: 0}, Date.prototype.dateFormat = function(e){
        if("unixtime" == e) return parseInt(this.getTime() / 1e3);
        null == Date.formatFunctions[e] && Date.createNewFormat(e);
        var t = Date.formatFunctions[e];
        return this[t]()
    }, Date.createNewFormat = function(format){
        var funcName = "format" + Date.formatFunctions.count++;
        Date.formatFunctions[format] = funcName;
        for(var code = "Date.prototype." + funcName + " = function() {return ", special = !1, ch = "", i = 0 ; i < format.length ; ++i) ch = format.charAt(i), special || "\\" != ch? special? (special = !1, code += "'" + String.escape(ch) + "' + ") : code += Date.getFormatCode(ch) : special = !0;
        eval(code.substring(0, code.length - 3) + ";}")
    }, Date.getFormatCode = function(e){
        switch(e)
        {
            case"d":
                return "String.leftPad(this.getDate(), 2, '0') + ";
            case"D":
                return "Date.dayNames[this.getDay()].substring(0, 3) + ";
            case"j":
                return "this.getDate() + ";
            case"l":
                return "Date.dayNames[this.getDay()] + ";
            case"S":
                return "this.getSuffix() + ";
            case"w":
                return "this.getDay() + ";
            case"z":
                return "this.getDayOfYear() + ";
            case"W":
                return "this.getWeekOfYear() + ";
            case"F":
                return "Date.monthNames[this.getMonth()] + ";
            case"m":
                return "String.leftPad(this.getMonth() + 1, 2, '0') + ";
            case"M":
                return "Date.monthNames[this.getMonth()].substring(0, 3) + ";
            case"n":
                return "(this.getMonth() + 1) + ";
            case"t":
                return "this.getDaysInMonth() + ";
            case"L":
                return "(this.isLeapYear() ? 1 : 0) + ";
            case"Y":
                return "this.getFullYear() + ";
            case"y":
                return "('' + this.getFullYear()).substring(2, 4) + ";
            case"a":
                return "(this.getHours() < 12 ? 'am' : 'pm') + ";
            case"A":
                return "(this.getHours() < 12 ? 'AM' : 'PM') + ";
            case"g":
                return "((this.getHours() %12) ? this.getHours() % 12 : 12) + ";
            case"G":
                return "this.getHours() + ";
            case"h":
                return "String.leftPad((this.getHours() %12) ? this.getHours() % 12 : 12, 2, '0') + ";
            case"H":
                return "String.leftPad(this.getHours(), 2, '0') + ";
            case"i":
                return "String.leftPad(this.getMinutes(), 2, '0') + ";
            case"s":
                return "String.leftPad(this.getSeconds(), 2, '0') + ";
            case"O":
                return "this.getGMTOffset() + ";
            case"T":
                return "this.getTimezone() + ";
            case"Z":
                return "(this.getTimezoneOffset() * -60) + ";
            default:
                return "'" + String.escape(e) + "' + "
        }
    }, Date.parseDate = function(e, t){
        if("unixtime" == t) return new Date(isNaN(parseInt(e))? 0 : 1e3 * parseInt(e));
        null == Date.parseFunctions[t] && Date.createParser(t);
        var n = Date.parseFunctions[t];
        return Date[n](e)
    }, Date.createParser = function(format){
        var funcName = "parse" + Date.parseFunctions.count++, regexNum = Date.parseRegexes.length, currentGroup = 1;
        Date.parseFunctions[format] = funcName;
        for(var code = "Date." + funcName + " = function(input) {\nvar y = -1, m = -1, d = -1, h = -1, i = -1, s = -1, z = -1;\nvar d = new Date();\ny = d.getFullYear();\nm = d.getMonth();\nd = d.getDate();\nvar results = input.match(Date.parseRegexes[" + regexNum + "]);\nif (results && results.length > 0) {", regex = "", special = !1, ch = "", i = 0 ; i < format.length ; ++i) ch = format.charAt(i), special || "\\" != ch? special? (special = !1, regex += String.escape(ch)) : (obj = Date.formatCodeToRegex(ch, currentGroup), currentGroup += obj.g, regex += obj.s, obj.g && obj.c && (code += obj.c)) : special = !0;
        code += "if (y > 0 && z > 0){\nvar doyDate = new Date(y,0);\ndoyDate.setDate(z);\nm = doyDate.getMonth();\nd = doyDate.getDate();\n}", code += "if (y > 0 && m >= 0 && d > 0 && h >= 0 && i >= 0 && s >= 0)\n{return new Date(y, m, d, h, i, s);}\nelse if (y > 0 && m >= 0 && d > 0 && h >= 0 && i >= 0)\n{return new Date(y, m, d, h, i);}\nelse if (y > 0 && m >= 0 && d > 0 && h >= 0)\n{return new Date(y, m, d, h);}\nelse if (y > 0 && m >= 0 && d > 0)\n{return new Date(y, m, d);}\nelse if (y > 0 && m >= 0)\n{return new Date(y, m);}\nelse if (y > 0)\n{return new Date(y);}\n}return null;}", Date.parseRegexes[regexNum] = new RegExp("^" + regex + "$"), eval(code)
    }, Date.formatCodeToRegex = function(e, t){
        switch(e)
        {
            case"D":
                return {g: 0, c: null, s: "(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)"};
            case"j":
            case"d":
                return {g: 1, c: "d = parseInt(results[" + t + "], 10);\n", s: "(\\d{1,2})"};
            case"l":
                return {g: 0, c: null, s: "(?:" + Date.dayNames.join("|") + ")"};
            case"S":
                return {g: 0, c: null, s: "(?:st|nd|rd|th)"};
            case"w":
                return {g: 0, c: null, s: "\\d"};
            case"z":
                return {g: 1, c: "z = parseInt(results[" + t + "], 10);\n", s: "(\\d{1,3})"};
            case"W":
                return {g: 0, c: null, s: "(?:\\d{2})"};
            case"F":
                return {
                    g: 1,
                    c: "m = parseInt(Date.monthNumbers[results[" + t + "].substring(0, 3)], 10);\n",
                    s: "(" + Date.monthNames.join("|") + ")"
                };
            case"M":
                return {
                    g: 1,
                    c: "m = parseInt(Date.monthNumbers[results[" + t + "]], 10);\n",
                    s: "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
                };
            case"n":
            case"m":
                return {g: 1, c: "m = parseInt(results[" + t + "], 10) - 1;\n", s: "(\\d{1,2})"};
            case"t":
                return {g: 0, c: null, s: "\\d{1,2}"};
            case"L":
                return {g: 0, c: null, s: "(?:1|0)"};
            case"Y":
                return {g: 1, c: "y = parseInt(results[" + t + "], 10);\n", s: "(\\d{4})"};
            case"y":
                return {
                    g: 1,
                    c: "var ty = parseInt(results[" + t + "], 10);\ny = ty > Date.y2kYear ? 1900 + ty : 2000 + ty;\n",
                    s: "(\\d{1,2})"
                };
            case"a":
                return {
                    g: 1,
                    c: "if (results[" + t + "] == 'am') {\nif (h == 12) { h = 0; }\n} else { if (h < 12) { h += 12; }}",
                    s: "(am|pm)"
                };
            case"A":
                return {
                    g: 1,
                    c: "if (results[" + t + "] == 'AM') {\nif (h == 12) { h = 0; }\n} else { if (h < 12) { h += 12; }}",
                    s: "(AM|PM)"
                };
            case"g":
            case"G":
            case"h":
            case"H":
                return {g: 1, c: "h = parseInt(results[" + t + "], 10);\n", s: "(\\d{1,2})"};
            case"i":
                return {g: 1, c: "i = parseInt(results[" + t + "], 10);\n", s: "(\\d{2})"};
            case"s":
                return {g: 1, c: "s = parseInt(results[" + t + "], 10);\n", s: "(\\d{2})"};
            case"O":
                return {g: 0, c: null, s: "[+-]\\d{4}"};
            case"T":
                return {g: 0, c: null, s: "[A-Z]{3}"};
            case"Z":
                return {g: 0, c: null, s: "[+-]\\d{1,5}"};
            default:
                return {g: 0, c: null, s: String.escape(e)}
        }
    }, Date.prototype.getTimezone = function(){
        return this.toString().replace(/^.*? ([A-Z]{3}) [0-9]{4}.*$/, "$1").replace(/^.*?\(([A-Z])[a-z]+ ([A-Z])[a-z]+ ([A-Z])[a-z]+\)$/, "$1$2$3")
    }, Date.prototype.getGMTOffset = function(){
        return (this.getTimezoneOffset() > 0? "-" : "+") + String.leftPad(Math.floor(Math.abs(this.getTimezoneOffset()) / 60), 2, "0") + String.leftPad(Math.abs(this.getTimezoneOffset()) % 60, 2, "0")
    }, Date.prototype.getDayOfYear = function(){
        var e = 0;
        Date.daysInMonth[1] = this.isLeapYear()? 29 : 28;
        for(var t = 0 ; t < this.getMonth() ; ++t) e += Date.daysInMonth[t];
        return e + this.getDate()
    }, Date.prototype.getWeekOfYear = function(){
        var e = this.getDayOfYear() + (4 - this.getDay()), t = new Date(this.getFullYear(), 0, 1),
            n = 7 - t.getDay() + 4;
        return String.leftPad(Math.ceil((e - n) / 7) + 1, 2, "0")
    }, Date.prototype.isLeapYear = function(){
        var e = this.getFullYear();
        return 0 == (3 & e) && (e % 100 || e % 400 == 0 && e)
    }, Date.prototype.getFirstDayOfMonth = function(){
        var e = (this.getDay() - (this.getDate() - 1)) % 7;
        return 0 > e? e + 7 : e
    }, Date.prototype.getLastDayOfMonth = function(){
        var e = (this.getDay() + (Date.daysInMonth[this.getMonth()] - this.getDate())) % 7;
        return 0 > e? e + 7 : e
    }, Date.prototype.getDaysInMonth = function(){
        return Date.daysInMonth[1] = this.isLeapYear()? 29 : 28, Date.daysInMonth[this.getMonth()]
    }, Date.prototype.getSuffix = function(){
        switch(this.getDate())
        {
            case 1:
            case 21:
            case 31:
                return "st";
            case 2:
            case 22:
                return "nd";
            case 3:
            case 23:
                return "rd";
            default:
                return "th"
        }
    }, String.escape = function(e){
        return e.replace(/('|\\)/g, "\\$1")
    }, String.leftPad = function(e, t, n){
        var a = new String(e);
        for(null == n && (n = " ") ; a.length < t ;) a = n + a;
        return a
    }, Date.daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], Date.monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], Date.dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], Date.y2kYear = 50, Date.monthNumbers = {
        Jan: 0,
        Feb: 1,
        Mar: 2,
        Apr: 3,
        May: 4,
        Jun: 5,
        Jul: 6,
        Aug: 7,
        Sep: 8,
        Oct: 9,
        Nov: 10,
        Dec: 11
    }, Date.patterns = {
        ISO8601LongPattern              : "Y-m-d H:i:s",
        ISO8601ShortPattern             : "Y-m-d",
        ShortDatePattern                : "n/j/Y",
        LongDatePattern                 : "l, F d, Y",
        FullDateTimePattern             : "l, F d, Y g:i:s A",
        MonthDayPattern                 : "F d",
        ShortTimePattern                : "g:i A",
        LongTimePattern                 : "g:i:s A",
        SortableDateTimePattern         : "Y-m-d\\TH:i:s",
        UniversalSortableDateTimePattern: "Y-m-d H:i:sO",
        YearMonthPattern                : "F, Y"
    }
}();
/**
 * @static
 * @public
 * @param {string} input
 * @param {string} format
 * @returns {Date}
 */
Date.parseDate = function(input, format){
    return window["moment"](input, format)["toDate"]();
};

/**
 * @public
 * @param {string} format
 * @returns {string}
 */
Date.prototype.dateFormat = function(format){
    return window["moment"](this)["format"](format);
};

/*! noUiSlider - 7.0.10 - 2014-12-27 14:50:47 */

!function(a){
    "use strict";

    function b(a, b)
    {
        return Math.round(a / b) * b
    }

    function c(a)
    {
        return "number" == typeof a && !isNaN(a) && isFinite(a)
    }

    function d(a)
    {
        var b = Math.pow(10, 7);
        return Number((Math.round(a * b) / b).toFixed(7))
    }

    function e(a, b, c)
    {
        a.addClass(b), setTimeout(function(){
            a.removeClass(b)
        }, c)
    }

    function f(a)
    {
        return Math.max(Math.min(a, 100), 0)
    }

    function g(b)
    {
        return a.isArray(b)? b : [b]
    }

    function h(a)
    {
        var b = a.split(".");
        return b.length > 1? b[1].length : 0
    }

    function i(a, b)
    {
        return 100 / (b - a)
    }

    function j(a, b)
    {
        return 100 * b / (a[1] - a[0])
    }

    function k(a, b)
    {
        return j(a, a[0] < 0? b + Math.abs(a[0]) : b - a[0])
    }

    function l(a, b)
    {
        return b * (a[1] - a[0]) / 100 + a[0]
    }

    function m(a, b)
    {
        for(var c = 1 ; a >= b[c] ;) c += 1;
        return c
    }

    function n(a, b, c)
    {
        if(c >= a.slice(-1)[0]) return 100;
        var d, e, f, g, h = m(c, a);
        return d = a[h - 1], e = a[h], f = b[h - 1], g = b[h], f + k([d, e], c) / i(f, g)
    }

    function o(a, b, c)
    {
        if(c >= 100) return a.slice(-1)[0];
        var d, e, f, g, h = m(c, b);
        return d = a[h - 1], e = a[h], f = b[h - 1], g = b[h], l([d, e], (c - f) * i(f, g))
    }

    function p(a, c, d, e)
    {
        if(100 === e) return e;
        var f, g, h = m(e, a);
        return d? (f = a[h - 1], g = a[h], e - f > (g - f) / 2? g : f) : c[h - 1]? a[h - 1] + b(e - a[h - 1], c[h - 1]) : e
    }

    function q(a, b, d)
    {
        var e;
        if("number" == typeof b && (b = [b]), "[object Array]" !== Object.prototype.toString.call(b)) throw new Error("noUiSlider: 'range' contains invalid value.");
        if(e = "min" === a? 0 : "max" === a? 100 : parseFloat(a), !c(e) || !c(b[0])) throw new Error("noUiSlider: 'range' value isn't numeric.");
        d.xPct.push(e), d.xVal.push(b[0]), e? d.xSteps.push(isNaN(b[1])? !1 : b[1]) : isNaN(b[1]) || (d.xSteps[0] = b[1])
    }

    function r(a, b, c)
    {
        return b? void(c.xSteps[a] = j([c.xVal[a], c.xVal[a + 1]], b) / i(c.xPct[a], c.xPct[a + 1])) : !0
    }

    function s(a, b, c, d)
    {
        this.xPct = [], this.xVal = [], this.xSteps = [d || !1], this.xNumSteps = [!1], this.snap = b, this.direction = c;
        var e, f = [];
        for(e in a) a.hasOwnProperty(e) && f.push([a[e], e]);
        for(f.sort(function(a, b){
            return a[0] - b[0]
        }), e = 0 ; e < f.length ; e++) q(f[e][1], f[e][0], this);
        for(this.xNumSteps = this.xSteps.slice(0), e = 0 ; e < this.xNumSteps.length ; e++) r(e, this.xNumSteps[e], this)
    }

    function t(a, b)
    {
        if(!c(b)) throw new Error("noUiSlider: 'step' is not numeric.");
        a.singleStep = b
    }

    function u(b, c)
    {
        if("object" != typeof c || a.isArray(c)) throw new Error("noUiSlider: 'range' is not an object.");
        if(void 0 === c.min || void 0 === c.max) throw new Error("noUiSlider: Missing 'min' or 'max' in 'range'.");
        b.spectrum = new s(c, b.snap, b.dir, b.singleStep)
    }

    function v(b, c)
    {
        if(c = g(c), !a.isArray(c) || !c.length || c.length > 2) throw new Error("noUiSlider: 'start' option is incorrect.");
        b.handles = c.length, b.start = c
    }

    function w(a, b)
    {
        if(a.snap = b, "boolean" != typeof b) throw new Error("noUiSlider: 'snap' option must be a boolean.")
    }

    function x(a, b)
    {
        if(a.animate = b, "boolean" != typeof b) throw new Error("noUiSlider: 'animate' option must be a boolean.")
    }

    function y(a, b)
    {
        if("lower" === b && 1 === a.handles) a.connect = 1;
        else if("upper" === b && 1 === a.handles) a.connect = 2;
        else if(b === !0 && 2 === a.handles) a.connect = 3;
        else
        {
            if(b !== !1) throw new Error("noUiSlider: 'connect' option doesn't match handle count.");
            a.connect = 0
        }
    }

    function z(a, b)
    {
        switch(b)
        {
            case"horizontal":
                a.ort = 0;
                break;
            case"vertical":
                a.ort = 1;
                break;
            default:
                throw new Error("noUiSlider: 'orientation' option is invalid.")
        }
    }

    function A(a, b)
    {
        if(!c(b)) throw new Error("noUiSlider: 'margin' option must be numeric.");
        if(a.margin = a.spectrum.getMargin(b), !a.margin) throw new Error("noUiSlider: 'margin' option is only supported on linear sliders.")
    }

    function B(a, b)
    {
        if(!c(b)) throw new Error("noUiSlider: 'limit' option must be numeric.");
        if(a.limit = a.spectrum.getMargin(b), !a.limit) throw new Error("noUiSlider: 'limit' option is only supported on linear sliders.")
    }

    function C(a, b)
    {
        switch(b)
        {
            case"ltr":
                a.dir = 0;
                break;
            case"rtl":
                a.dir = 1, a.connect = [0, 2, 1, 3][a.connect];
                break;
            default:
                throw new Error("noUiSlider: 'direction' option was not recognized.")
        }
    }

    function D(a, b)
    {
        if("string" != typeof b) throw new Error("noUiSlider: 'behaviour' must be a string containing options.");
        var c = b.indexOf("tap") >= 0, d = b.indexOf("drag") >= 0, e = b.indexOf("fixed") >= 0,
            f = b.indexOf("snap") >= 0;
        a.events = {tap: c || f, drag: d, fixed: e, snap: f}
    }

    function E(a, b)
    {
        if(a.format = b, "function" == typeof b.to && "function" == typeof b.from) return !0;
        throw new Error("noUiSlider: 'format' requires 'to' and 'from' methods.")
    }

    function F(b)
    {
        var c, d = {margin: 0, limit: 0, animate: !0, format: V};
        return c = {
            step       : {r: !1, t: t},
            start      : {r: !0, t: v},
            connect    : {r: !0, t: y},
            direction  : {r: !0, t: C},
            snap       : {r: !1, t: w},
            animate    : {r: !1, t: x},
            range      : {r: !0, t: u},
            orientation: {r: !1, t: z},
            margin     : {r: !1, t: A},
            limit      : {r: !1, t: B},
            behaviour  : {r: !0, t: D},
            format     : {r: !1, t: E}
        }, b = a.extend({
            connect    : !1,
            direction  : "ltr",
            behaviour  : "tap",
            orientation: "horizontal"
        }, b), a.each(c, function(a, c){
            if(void 0 === b[a])
            {
                if(c.r) throw new Error("noUiSlider: '" + a + "' is required.");
                return !0
            }
            c.t(d, b[a])
        }), d.style = d.ort? "top" : "left", d
    }

    function G(a, b, c)
    {
        var d = a + b[0], e = a + b[1];
        return c? (0 > d && (e += Math.abs(d)), e > 100 && (d -= e - 100), [f(d), f(e)]) : [d, e]
    }

    function H(a)
    {
        a.preventDefault();
        var b, c, d = 0 === a.type.indexOf("touch"), e = 0 === a.type.indexOf("mouse"),
            f = 0 === a.type.indexOf("pointer"), g = a;
        return 0 === a.type.indexOf("MSPointer") && (f = !0), a.originalEvent && (a = a.originalEvent), d && (b = a.changedTouches[0].pageX, c = a.changedTouches[0].pageY), (e || f) && (f || void 0 !== window.pageXOffset || (window.pageXOffset = document.documentElement.scrollLeft, window.pageYOffset = document.documentElement.scrollTop), b = a.clientX + window.pageXOffset, c = a.clientY + window.pageYOffset), g.points = [b, c], g.cursor = e, g
    }

    function I(b, c)
    {
        var d = a("<div><div/></div>").addClass(U[2]), e = ["-lower", "-upper"];
        return b && e.reverse(), d.children().addClass(U[3] + " " + U[3] + e[c]), d
    }

    function J(a, b, c)
    {
        switch(a)
        {
            case 1:
                b.addClass(U[7]), c[0].addClass(U[6]);
                break;
            case 3:
                c[1].addClass(U[6]);
            case 2:
                c[0].addClass(U[7]);
            case 0:
                b.addClass(U[6])
        }
    }

    function K(a, b, c)
    {
        var d, e = [];
        for(d = 0 ; a > d ; d += 1) e.push(I(b, d).appendTo(c));
        return e
    }

    function L(b, c, d)
    {
        return d.addClass([U[0], U[8 + b], U[4 + c]].join(" ")), a("<div/>").appendTo(d).addClass(U[1])
    }

    function M(b, c, d)
    {
        function i()
        {
            return C[["width", "height"][c.ort]]()
        }

        function j(a)
        {
            var b, c = [E.val()];
            for(b = 0 ; b < a.length ; b += 1) E.trigger(a[b], c)
        }

        function k(a)
        {
            return 1 === a.length? a[0] : c.dir? a.reverse() : a
        }

        function l(a)
        {
            return function(b, c){
                E.val([a? null : c, a? c : null], !0)
            }
        }

        function m(b)
        {
            var c = a.inArray(b, N);
            E[0].linkAPI && E[0].linkAPI[b] && E[0].linkAPI[b].change(M[c], D[c].children(), E)
        }

        function n(b, d)
        {
            var e = a.inArray(b, N);
            return d && d.appendTo(D[e].children()), c.dir && c.handles > 1 && (e = 1 === e? 0 : 1), l(e)
        }

        function o()
        {
            var a, b;
            for(a = 0 ; a < N.length ; a += 1) this.linkAPI && this.linkAPI[b = N[a]] && this.linkAPI[b].reconfirm(b)
        }

        function p(a, b, d, e)
        {
            return a = a.replace(/\s/g, S + " ") + S, b.on(a, function(a){
                return E.attr("disabled")? !1 : E.hasClass(U[14])? !1 : (a = H(a), a.calcPoint = a.points[c.ort], void d(a, e))
            })
        }

        function q(a, b)
        {
            var c, d = b.handles || D, e = !1, f = 100 * (a.calcPoint - b.start) / i(), g = d[0][0] !== D[0][0]? 1 : 0;
            c = G(f, b.positions, d.length > 1), e = v(d[0], c[g], 1 === d.length), d.length > 1 && (e = v(d[1], c[g? 0 : 1], !1) || e), e && j(["slide"])
        }

        function r(b)
        {
            a("." + U[15]).removeClass(U[15]), b.cursor && a("body").css("cursor", "").off(S), Q.off(S), E.removeClass(U[12]), j(["set", "change"])
        }

        function s(b, c)
        {
            1 === c.handles.length && c.handles[0].children().addClass(U[15]), b.stopPropagation(), p(T.move, Q, q, {
                start    : b.calcPoint,
                handles  : c.handles,
                positions: [F[0], F[D.length - 1]]
            }), p(T.end, Q, r, null), b.cursor && (a("body").css("cursor", a(b.target).css("cursor")), D.length > 1 && E.addClass(U[12]), a("body").on("selectstart" + S, !1))
        }

        function t(b)
        {
            var d, f = b.calcPoint, g = 0;
            b.stopPropagation(), a.each(D, function(){
                g += this.offset()[c.style]
            }), g = g / 2 > f || 1 === D.length? 0 : 1, f -= C.offset()[c.style], d = 100 * f / i(), c.events.snap || e(E, U[14], 300), v(D[g], d), j(["slide", "set", "change"]), c.events.snap && s(b, {handles: [D[g]]})
        }

        function u(a)
        {
            var b, c;
            if(!a.fixed) for(b = 0 ; b < D.length ; b += 1) p(T.start, D[b].children(), s, {handles: [D[b]]});
            a.tap && p(T.start, C, t, {handles: D}), a.drag && (c = C.find("." + U[7]).addClass(U[10]), a.fixed && (c = c.add(C.children().not(c).children())), p(T.start, c, s, {handles: D}))
        }

        function v(a, b, d)
        {
            var e = a[0] !== D[0][0]? 1 : 0, g = F[0] + c.margin, h = F[1] - c.margin, i = F[0] + c.limit,
                j = F[1] - c.limit;
            return D.length > 1 && (b = e? Math.max(b, g) : Math.min(b, h)), d !== !1 && c.limit && D.length > 1 && (b = e? Math.min(b, i) : Math.max(b, j)), b = I.getStep(b), b = f(parseFloat(b.toFixed(7))), b === F[e]? !1 : (a.css(c.style, b + "%"), a.is(":first-child") && a.toggleClass(U[17], b > 50), F[e] = b, M[e] = I.fromStepping(b), m(N[e]), !0)
        }

        function w(a, b)
        {
            var d, e, f;
            for(c.limit && (a += 1), d = 0 ; a > d ; d += 1) e = d % 2, f = b[e], null !== f && f !== !1 && ("number" == typeof f && (f = String(f)), f = c.format.from(f), (f === !1 || isNaN(f) || v(D[e], I.toStepping(f), d === 3 - c.dir) === !1) && m(N[e]))
        }

        function x(a)
        {
            if(E[0].LinkIsEmitting) return this;
            var b, d = g(a);
            return c.dir && c.handles > 1 && d.reverse(), c.animate && -1 !== F[0] && e(E, U[14], 300), b = D.length > 1? 3 : 1, 1 === d.length && (b = 1), w(b, d), j(["set"]), this
        }

        function y()
        {
            var a, b = [];
            for(a = 0 ; a < c.handles ; a += 1) b[a] = c.format.to(M[a]);
            return k(b)
        }

        function z()
        {
            return a(this).off(S).removeClass(U.join(" ")).empty(), delete this.LinkUpdate, delete this.LinkConfirm, delete this.LinkDefaultFormatter, delete this.LinkDefaultFlag, delete this.reappend, delete this.vGet, delete this.vSet, delete this.getCurrentStep, delete this.getInfo, delete this.destroy, d
        }

        function A()
        {
            var b = a.map(F, function(a, b){
                var c = I.getApplicableStep(a), d = h(String(c[2])), e = M[b], f = 100 === a? null : c[2],
                    g = Number((e - c[2]).toFixed(d)), i = 0 === a? null : g >= c[1]? c[2] : c[0] || !1;
                return [[i, f]]
            });
            return k(b)
        }

        function B()
        {
            return d
        }

        var C, D, E = a(b), F = [-1, -1], I = c.spectrum, M = [], N = ["lower", "upper"].slice(0, c.handles);
        if(c.dir && N.reverse(), b.LinkUpdate = m, b.LinkConfirm = n, b.LinkDefaultFormatter = c.format, b.LinkDefaultFlag = "lower", b.reappend = o, E.hasClass(U[0])) throw new Error("Slider was already initialized.");
        C = L(c.dir, c.ort, E), D = K(c.handles, c.dir, C), J(c.connect, E, D), u(c.events), b.vSet = x, b.vGet = y, b.destroy = z, b.getCurrentStep = A, b.getOriginalOptions = B, b.getInfo = function(){
            return [I, c.style, c.ort]
        }, E.val(c.start)
    }

    function N(a)
    {
        var b = F(a, this);
        return this.each(function(){
            M(this, b, a)
        })
    }

    function O(b)
    {
        return this.each(function(){
            if(!this.destroy) return void a(this).noUiSlider(b);
            var c = a(this).val(), d = this.destroy(), e = a.extend({}, d, b);
            a(this).noUiSlider(e), this.reappend(), d.start === e.start && a(this).val(c)
        })
    }

    function P()
    {
        return this[0][arguments.length? "vSet" : "vGet"].apply(this[0], arguments)
    }

    var Q = a(document), R = a.fn.val, S = ".nui", T = window.navigator.pointerEnabled? {
            start: "pointerdown",
            move: "pointermove",
            end: "pointerup"
        } : window.navigator.msPointerEnabled? {
            start: "MSPointerDown",
            move: "MSPointerMove",
            end: "MSPointerUp"
        } : {start: "mousedown touchstart", move: "mousemove touchmove", end: "mouseup touchend"},
        U = ["noUi-target", "noUi-base", "noUi-origin", "noUi-handle", "noUi-horizontal", "noUi-vertical", "noUi-background", "noUi-connect", "noUi-ltr", "noUi-rtl", "noUi-dragable", "", "noUi-state-drag", "", "noUi-state-tap", "noUi-active", "", "noUi-stacking"];
    s.prototype.getMargin = function(a){
        return 2 === this.xPct.length? j(this.xVal, a) : !1
    }, s.prototype.toStepping = function(a){
        return a = n(this.xVal, this.xPct, a), this.direction && (a = 100 - a), a
    }, s.prototype.fromStepping = function(a){
        return this.direction && (a = 100 - a), d(o(this.xVal, this.xPct, a))
    }, s.prototype.getStep = function(a){
        return this.direction && (a = 100 - a), a = p(this.xPct, this.xSteps, this.snap, a), this.direction && (a = 100 - a), a
    }, s.prototype.getApplicableStep = function(a){
        var b = m(a, this.xPct), c = 100 === a? 2 : 1;
        return [this.xNumSteps[b - 2], this.xVal[b - c], this.xNumSteps[b - c]]
    }, s.prototype.convert = function(a){
        return this.getStep(this.toStepping(a))
    };
    var V = {
        to     : function(a){
            return a.toFixed(2)
        }, from: Number
    };
    a.fn.val = function(b){
        function c(a)
        {
            return a.hasClass(U[0])? P : R
        }

        if(!arguments.length)
        {
            var d = a(this[0]);
            return c(d).call(d)
        }
        var e = a.isFunction(b);
        return this.each(function(d){
            var f = b, g = a(this);
            e && (f = b.call(this, d, g.val())), c(g).call(g, f)
        })
    }, a.fn.noUiSlider = function(a, b){
        switch(a)
        {
            case"step":
                return this[0].getCurrentStep();
            case"options":
                return this[0].getOriginalOptions()
        }
        return (b? O : N).call(this, a)
    }
}(window.jQuery || window.Zepto);

/*! Select2 4.0.0-rc.2 | https://github.com/select2/select2/blob/master/LICENSE.md */
!function(a){
    "function" == typeof define && define.amd? define(["jquery"], a) : a("object" == typeof exports? require("jquery") : jQuery)
}(function(a){
    var b = function(){
        if(a && a.fn && a.fn.select2 && a.fn.select2.amd) var b = a.fn.select2.amd;
        var b;
        return function(){
            if(!b || !b.requirejs)
            {
                b? c = b : b = {};
                var a, c, d;
                !function(b){
                    function e(a, b)
                    {
                        return u.call(a, b)
                    }

                    function f(a, b)
                    {
                        var c, d, e, f, g, h, i, j, k, l, m, n = b && b.split("/"), o = s.map, p = o && o["*"] || {};
                        if(a && "." === a.charAt(0)) if(b)
                        {
                            for(n = n.slice(0, n.length - 1), a = a.split("/"), g = a.length - 1, s.nodeIdCompat && w.test(a[g]) && (a[g] = a[g].replace(w, "")), a = n.concat(a), k = 0 ; k < a.length ; k += 1) if(m = a[k], "." === m) a.splice(k, 1), k -= 1;
                            else if(".." === m)
                            {
                                if(1 === k && (".." === a[2] || ".." === a[0])) break;
                                k > 0 && (a.splice(k - 1, 2), k -= 2)
                            }
                            a = a.join("/")
                        }
                        else 0 === a.indexOf("./") && (a = a.substring(2));
                        if((n || p) && o)
                        {
                            for(c = a.split("/"), k = c.length ; k > 0 ; k -= 1)
                            {
                                if(d = c.slice(0, k).join("/"), n) for(l = n.length ; l > 0 ; l -= 1) if(e = o[n.slice(0, l).join("/")], e && (e = e[d]))
                                {
                                    f = e, h = k;
                                    break
                                }
                                if(f) break;
                                !i && p && p[d] && (i = p[d], j = k)
                            }
                            !f && i && (f = i, h = j), f && (c.splice(0, h, f), a = c.join("/"))
                        }
                        return a
                    }

                    function g(a, c)
                    {
                        return function(){
                            return n.apply(b, v.call(arguments, 0).concat([a, c]))
                        }
                    }

                    function h(a)
                    {
                        return function(b){
                            return f(b, a)
                        }
                    }

                    function i(a)
                    {
                        return function(b){
                            q[a] = b
                        }
                    }

                    function j(a)
                    {
                        if(e(r, a))
                        {
                            var c = r[a];
                            delete r[a], t[a] = !0, m.apply(b, c)
                        }
                        if(!e(q, a) && !e(t, a)) throw new Error("No " + a);
                        return q[a]
                    }

                    function k(a)
                    {
                        var b, c = a? a.indexOf("!") : -1;
                        return c > -1 && (b = a.substring(0, c), a = a.substring(c + 1, a.length)), [b, a]
                    }

                    function l(a)
                    {
                        return function(){
                            return s && s.config && s.config[a] || {}
                        }
                    }

                    var m, n, o, p, q = {}, r = {}, s = {}, t = {}, u = Object.prototype.hasOwnProperty, v = [].slice,
                        w = /\.js$/;
                    o = function(a, b){
                        var c, d = k(a), e = d[0];
                        return a = d[1], e && (e = f(e, b), c = j(e)), e? a = c && c.normalize? c.normalize(a, h(b)) : f(a, b) : (a = f(a, b), d = k(a), e = d[0], a = d[1], e && (c = j(e))), {
                            f : e? e + "!" + a : a,
                            n : a,
                            pr: e,
                            p : c
                        }
                    }, p = {
                        require   : function(a){
                            return g(a)
                        }, exports: function(a){
                            var b = q[a];
                            return "undefined" != typeof b? b : q[a] = {}
                        }, module : function(a){
                            return {id: a, uri: "", exports: q[a], config: l(a)}
                        }
                    }, m = function(a, c, d, f){
                        var h, k, l, m, n, s, u = [], v = typeof d;
                        if(f = f || a, "undefined" === v || "function" === v)
                        {
                            for(c = !c.length && d.length? ["require", "exports", "module"] : c, n = 0 ; n < c.length ; n += 1) if(m = o(c[n], f), k = m.f, "require" === k) u[n] = p.require(a);
                            else if("exports" === k) u[n] = p.exports(a), s = !0;
                            else if("module" === k) h = u[n] = p.module(a);
                            else if(e(q, k) || e(r, k) || e(t, k)) u[n] = j(k);
                            else
                            {
                                if(!m.p) throw new Error(a + " missing " + k);
                                m.p.load(m.n, g(f, !0), i(k), {}), u[n] = q[k]
                            }
                            l = d? d.apply(q[a], u) : void 0, a && (h && h.exports !== b && h.exports !== q[a]? q[a] = h.exports : l === b && s || (q[a] = l))
                        }
                        else a && (q[a] = d)
                    }, a = c = n = function(a, c, d, e, f){
                        if("string" == typeof a) return p[a]? p[a](c) : j(o(a, c).f);
                        if(!a.splice)
                        {
                            if(s = a, s.deps && n(s.deps, s.callback), !c) return;
                            c.splice? (a = c, c = d, d = null) : a = b
                        }
                        return c = c || function(){
                        }, "function" == typeof d && (d = e, e = f), e? m(b, a, c, d) : setTimeout(function(){
                            m(b, a, c, d)
                        }, 4), n
                    }, n.config = function(a){
                        return n(a)
                    }, a._defined = q, d = function(a, b, c){
                        b.splice || (c = b, b = []), e(q, a) || e(r, a) || (r[a] = [a, b, c])
                    }, d.amd = {jQuery: !0}
                }(), b.requirejs = a, b.require = c, b.define = d
            }
        }(), b.define("almond", function(){
        }), b.define("jquery", [], function(){
            var b = a || $;
            return null == b && console && console.error && console.error("Select2: An instance of jQuery or a jQuery-compatible library was not found. Make sure that you are including jQuery before Select2 on your web page."), b
        }), b.define("select2/utils", ["jquery"], function(a){
            function b(a)
            {
                var b = a.prototype, c = [];
                for(var d in b)
                {
                    var e = b[d];
                    "function" == typeof e && "constructor" !== d && c.push(d)
                }
                return c
            }

            var c = {};
            c.Extend = function(a, b){
                function c()
                {
                    this.constructor = a
                }

                var d = {}.hasOwnProperty;
                for(var e in b) d.call(b, e) && (a[e] = b[e]);
                return c.prototype = b.prototype, a.prototype = new c, a.__super__ = b.prototype, a
            }, c.Decorate = function(a, c){
                function d()
                {
                    var b = Array.prototype.unshift, d = c.prototype.constructor.length, e = a.prototype.constructor;
                    d > 0 && (b.call(arguments, a.prototype.constructor), e = c.prototype.constructor), e.apply(this, arguments)
                }

                function e()
                {
                    this.constructor = d
                }

                var f = b(c), g = b(a);
                c.displayName = a.displayName, d.prototype = new e;
                for(var h = 0 ; h < g.length ; h++)
                {
                    var i = g[h];
                    d.prototype[i] = a.prototype[i]
                }
                for(var j = (function(a){
                    var b = function(){
                    };
                    a in d.prototype && (b = d.prototype[a]);
                    var e = c.prototype[a];
                    return function(){
                        var a = Array.prototype.unshift;
                        return a.call(arguments, b), e.apply(this, arguments)
                    }
                }), k = 0 ; k < f.length ; k++)
                {
                    var l = f[k];
                    d.prototype[l] = j(l)
                }
                return d
            };
            var d = function(){
                this.listeners = {}
            };
            return d.prototype.on = function(a, b){
                this.listeners = this.listeners || {}, a in this.listeners? this.listeners[a].push(b) : this.listeners[a] = [b]
            }, d.prototype.trigger = function(a){
                var b = Array.prototype.slice;
                this.listeners = this.listeners || {}, a in this.listeners && this.invoke(this.listeners[a], b.call(arguments, 1)), "*" in this.listeners && this.invoke(this.listeners["*"], arguments)
            }, d.prototype.invoke = function(a, b){
                for(var c = 0, d = a.length ; d > c ; c++) a[c].apply(this, b)
            }, c.Observable = d, c.generateChars = function(a){
                for(var b = "", c = 0 ; a > c ; c++)
                {
                    var d = Math.floor(36 * Math.random());
                    b += d.toString(36)
                }
                return b
            }, c.bind = function(a, b){
                return function(){
                    a.apply(b, arguments)
                }
            }, c._convertData = function(a){
                for(var b in a)
                {
                    var c = b.split("-"), d = a;
                    if(1 !== c.length)
                    {
                        for(var e = 0 ; e < c.length ; e++)
                        {
                            var f = c[e];
                            f = f.substring(0, 1).toLowerCase() + f.substring(1), f in d || (d[f] = {}), e == c.length - 1 && (d[f] = a[b]), d = d[f]
                        }
                        delete a[b]
                    }
                }
                return a
            }, c.hasScroll = function(b, c){
                var d = a(c), e = c.style.overflowX, f = c.style.overflowY;
                return e !== f || "hidden" !== f && "visible" !== f? "scroll" === e || "scroll" === f? !0 : d.innerHeight() < c.scrollHeight || d.innerWidth() < c.scrollWidth : !1
            }, c.escapeMarkup = function(a){
                var b = {
                    "\\": "&#92;",
                    "&" : "&amp;",
                    "<" : "&lt;",
                    ">" : "&gt;",
                    '"' : "&quot;",
                    "'" : "&#39;",
                    "/" : "&#47;"
                };
                return "string" != typeof a? a : String(a).replace(/[&<>"'\/\\]/g, function(a){
                    return b[a]
                })
            }, c
        }), b.define("select2/results", ["jquery", "./utils"], function(a, b){
            function c(a, b, d)
            {
                this.$element = a, this.data = d, this.options = b, c.__super__.constructor.call(this)
            }

            return b.Extend(c, b.Observable), c.prototype.render = function(){
                var b = a('<ul class="select2-results__options" role="tree"></ul>');
                return this.options.get("multiple") && b.attr("aria-multiselectable", "true"), this.$results = b, b
            }, c.prototype.clear = function(){
                this.$results.empty()
            }, c.prototype.displayMessage = function(b){
                var c = this.options.get("escapeMarkup");
                this.clear(), this.hideLoading();
                var d = a('<li role="treeitem" class="select2-results__option"></li>'),
                    e = this.options.get("translations").get(b.message);
                d.append(c(e(b.args))), this.$results.append(d)
            }, c.prototype.append = function(a){
                this.hideLoading();
                var b = [];
                if(null == a.results || 0 === a.results.length) return void(0 === this.$results.children().length && this.trigger("results:message", {message: "noResults"}));
                a.results = this.sort(a.results);
                for(var c = 0 ; c < a.results.length ; c++)
                {
                    var d = a.results[c], e = this.option(d);
                    b.push(e)
                }
                this.$results.append(b)
            }, c.prototype.position = function(a, b){
                var c = b.find(".select2-results");
                c.append(a)
            }, c.prototype.sort = function(a){
                var b = this.options.get("sorter");
                return b(a)
            }, c.prototype.setClasses = function(){
                var b = this;
                this.data.current(function(c){
                    var d = a.map(c, function(a){
                        return a.id.toString()
                    }), e = b.$results.find(".select2-results__option[aria-selected]");
                    e.each(function(){
                        var b = a(this), c = a.data(this, "data"), e = "" + c.id;
                        a.inArray(e, d) > -1? b.attr("aria-selected", "true") : b.attr("aria-selected", "false")
                    });
                    var f = e.filter("[aria-selected=true]");
                    f.length > 0? f.first().trigger("mouseenter") : e.first().trigger("mouseenter")
                })
            }, c.prototype.showLoading = function(a){
                this.hideLoading();
                var b = this.options.get("translations").get("searching"), c = {disabled: !0, loading: !0, text: b(a)},
                    d = this.option(c);
                d.className += " loading-results", this.$results.prepend(d)
            }, c.prototype.hideLoading = function(){
                this.$results.find(".loading-results").remove()
            }, c.prototype.option = function(b){
                var c = document.createElement("li");
                c.className = "select2-results__option";
                var d = {role: "treeitem", "aria-selected": "false"};
                b.disabled && (delete d["aria-selected"], d["aria-disabled"] = "true"), null == b.id && delete d["aria-selected"], null != b._resultId && (c.id = b._resultId), b.title && (c.title = b.title), b.children && (d.role = "group", d["aria-label"] = b.text, delete d["aria-selected"]);
                for(var e in d)
                {
                    var f = d[e];
                    c.setAttribute(e, f)
                }
                if(b.children)
                {
                    var g = a(c), h = document.createElement("strong");
                    h.className = "select2-results__group";
                    {
                        a(h)
                    }
                    this.template(b, h);
                    for(var i = [], j = 0 ; j < b.children.length ; j++)
                    {
                        var k = b.children[j], l = this.option(k);
                        i.push(l)
                    }
                    var m = a("<ul></ul>", {"class": "select2-results__options select2-results__options--nested"});
                    m.append(i), g.append(h), g.append(m)
                }
                else this.template(b, c);
                return a.data(c, "data", b), c
            }, c.prototype.bind = function(b){
                var c = this, d = b.id + "-results";
                this.$results.attr("id", d), b.on("results:all", function(a){
                    c.clear(), c.append(a.data), b.isOpen() && c.setClasses()
                }), b.on("results:append", function(a){
                    c.append(a.data), b.isOpen() && c.setClasses()
                }), b.on("query", function(a){
                    c.showLoading(a)
                }), b.on("select", function(){
                    b.isOpen() && c.setClasses()
                }), b.on("unselect", function(){
                    b.isOpen() && c.setClasses()
                }), b.on("open", function(){
                    c.$results.attr("aria-expanded", "true"), c.$results.attr("aria-hidden", "false"), c.setClasses(), c.ensureHighlightVisible()
                }), b.on("close", function(){
                    c.$results.attr("aria-expanded", "false"), c.$results.attr("aria-hidden", "true"), c.$results.removeAttr("aria-activedescendant")
                }), b.on("results:toggle", function(){
                    var a = c.getHighlightedResults();
                    0 !== a.length && a.trigger("mouseup")
                }), b.on("results:select", function(){
                    var a = c.getHighlightedResults();
                    if(0 !== a.length)
                    {
                        var b = a.data("data");
                        "true" == a.attr("aria-selected")? c.trigger("close") : c.trigger("select", {data: b})
                    }
                }), b.on("results:previous", function(){
                    var a = c.getHighlightedResults(), b = c.$results.find("[aria-selected]"), d = b.index(a);
                    if(0 !== d)
                    {
                        var e = d - 1;
                        0 === a.length && (e = 0);
                        var f = b.eq(e);
                        f.trigger("mouseenter");
                        var g = c.$results.offset().top, h = f.offset().top, i = c.$results.scrollTop() + (h - g);
                        0 === e? c.$results.scrollTop(0) : 0 > h - g && c.$results.scrollTop(i)
                    }
                }), b.on("results:next", function(){
                    var a = c.getHighlightedResults(), b = c.$results.find("[aria-selected]"), d = b.index(a),
                        e = d + 1;
                    if(!(e >= b.length))
                    {
                        var f = b.eq(e);
                        f.trigger("mouseenter");
                        var g = c.$results.offset().top + c.$results.outerHeight(!1),
                            h = f.offset().top + f.outerHeight(!1), i = c.$results.scrollTop() + h - g;
                        0 === e? c.$results.scrollTop(0) : h > g && c.$results.scrollTop(i)
                    }
                }), b.on("results:focus", function(a){
                    a.element.addClass("select2-results__option--highlighted")
                }), b.on("results:message", function(a){
                    c.displayMessage(a)
                }), a.fn.mousewheel && this.$results.on("mousewheel", function(a){
                    var b = c.$results.scrollTop(),
                        d = c.$results.get(0).scrollHeight - c.$results.scrollTop() + a.deltaY,
                        e = a.deltaY > 0 && b - a.deltaY <= 0, f = a.deltaY < 0 && d <= c.$results.height();
                    e? (c.$results.scrollTop(0), a.preventDefault(), a.stopPropagation()) : f && (c.$results.scrollTop(c.$results.get(0).scrollHeight - c.$results.height()), a.preventDefault(), a.stopPropagation())
                }), this.$results.on("mouseup", ".select2-results__option[aria-selected]", function(b){
                    var d = a(this), e = d.data("data");
                    return "true" === d.attr("aria-selected")? void(c.options.get("multiple")? c.trigger("unselect", {
                        originalEvent: b,
                        data         : e
                    }) : c.trigger("close")) : void c.trigger("select", {originalEvent: b, data: e})
                }), this.$results.on("mouseenter", ".select2-results__option[aria-selected]", function(){
                    var b = a(this).data("data");
                    c.getHighlightedResults().removeClass("select2-results__option--highlighted"), c.trigger("results:focus", {
                        data   : b,
                        element: a(this)
                    })
                })
            }, c.prototype.getHighlightedResults = function(){
                var a = this.$results.find(".select2-results__option--highlighted");
                return a
            }, c.prototype.destroy = function(){
                this.$results.remove()
            }, c.prototype.ensureHighlightVisible = function(){
                var a = this.getHighlightedResults();
                if(0 !== a.length)
                {
                    var b = this.$results.find("[aria-selected]"), c = b.index(a), d = this.$results.offset().top,
                        e = a.offset().top, f = this.$results.scrollTop() + (e - d), g = e - d;
                    f -= 2 * a.outerHeight(!1), 2 >= c? this.$results.scrollTop(0) : (g > this.$results.outerHeight() || 0 > g) && this.$results.scrollTop(f)
                }
            }, c.prototype.template = function(b, c){
                var d = this.options.get("templateResult"), e = this.options.get("escapeMarkup"), f = d(b);
                null == f? c.style.display = "none" : "string" == typeof f? c.innerHTML = e(f) : a(c).append(f)
            }, c
        }), b.define("select2/keys", [], function(){
            var a = {
                BACKSPACE: 8,
                TAB      : 9,
                ENTER    : 13,
                SHIFT    : 16,
                CTRL     : 17,
                ALT      : 18,
                ESC      : 27,
                SPACE    : 32,
                PAGE_UP  : 33,
                PAGE_DOWN: 34,
                END      : 35,
                HOME     : 36,
                LEFT     : 37,
                UP       : 38,
                RIGHT    : 39,
                DOWN     : 40,
                DELETE   : 46
            };
            return a
        }), b.define("select2/selection/base", ["jquery", "../utils", "../keys"], function(a, b, c){
            function d(a, b)
            {
                this.$element = a, this.options = b, d.__super__.constructor.call(this)
            }

            return b.Extend(d, b.Observable), d.prototype.render = function(){
                var b = a('<span class="select2-selection" role="combobox" aria-autocomplete="list" aria-haspopup="true" aria-expanded="false"></span>');
                return this._tabindex = 0, null != this.$element.data("old-tabindex")? this._tabindex = this.$element.data("old-tabindex") : null != this.$element.attr("tabindex") && (this._tabindex = this.$element.attr("tabindex")), b.attr("title", this.$element.attr("title")), b.attr("tabindex", this._tabindex), this.$selection = b, b
            }, d.prototype.bind = function(a){
                var b = this, d = (a.id + "-container", a.id + "-results");
                this.container = a, this.$selection.on("focus", function(a){
                    b.trigger("focus", a)
                }), this.$selection.on("blur", function(a){
                    b.trigger("blur", a)
                }), this.$selection.on("keydown", function(a){
                    b.trigger("keypress", a), a.which === c.SPACE && a.preventDefault()
                }), a.on("results:focus", function(a){
                    b.$selection.attr("aria-activedescendant", a.data._resultId)
                }), a.on("selection:update", function(a){
                    b.update(a.data)
                }), a.on("open", function(){
                    b.$selection.attr("aria-expanded", "true"), b.$selection.attr("aria-owns", d), b._attachCloseHandler(a)
                }), a.on("close", function(){
                    b.$selection.attr("aria-expanded", "false"), b.$selection.removeAttr("aria-activedescendant"), b.$selection.removeAttr("aria-owns"), b.$selection.focus(), b._detachCloseHandler(a)
                }), a.on("enable", function(){
                    b.$selection.attr("tabindex", b._tabindex)
                }), a.on("disable", function(){
                    b.$selection.attr("tabindex", "-1")
                })
            }, d.prototype._attachCloseHandler = function(b){
                a(document.body).on("mousedown.select2." + b.id, function(b){
                    var c = a(b.target), d = c.closest(".select2"), e = a(".select2.select2-container--open");
                    e.each(function(){
                        var b = a(this);
                        if(this != d[0])
                        {
                            var c = b.data("element");
                            c.select2("close")
                        }
                    })
                })
            }, d.prototype._detachCloseHandler = function(b){
                a(document.body).off("mousedown.select2." + b.id)
            }, d.prototype.position = function(a, b){
                var c = b.find(".selection");
                c.append(a)
            }, d.prototype.destroy = function(){
                this._detachCloseHandler(this.container)
            }, d.prototype.update = function(){
                throw new Error("The `update` method must be defined in child classes.")
            }, d
        }), b.define("select2/selection/single", ["jquery", "./base", "../utils", "../keys"], function(a, b, c){
            function d()
            {
                d.__super__.constructor.apply(this, arguments)
            }

            return c.Extend(d, b), d.prototype.render = function(){
                var a = d.__super__.render.call(this);
                return a.addClass("select2-selection--single"), a.html('<span class="select2-selection__rendered"></span><span class="select2-selection__arrow" role="presentation"><b role="presentation"></b></span>'), a
            }, d.prototype.bind = function(a){
                var b = this;
                d.__super__.bind.apply(this, arguments);
                var c = a.id + "-container";
                this.$selection.find(".select2-selection__rendered").attr("id", c), this.$selection.attr("aria-labelledby", c), this.$selection.on("mousedown", function(a){
                    1 === a.which && b.trigger("toggle", {originalEvent: a})
                }), this.$selection.on("focus", function(){
                }), this.$selection.on("blur", function(){
                }), a.on("selection:update", function(a){
                    b.update(a.data)
                })
            }, d.prototype.clear = function(){
                this.$selection.find(".select2-selection__rendered").empty()
            }, d.prototype.display = function(a){
                var b = this.options.get("templateSelection"), c = this.options.get("escapeMarkup");
                return c(b(a))
            }, d.prototype.selectionContainer = function(){
                return a("<span></span>")
            }, d.prototype.update = function(a){
                if(0 === a.length) return void this.clear();
                var b = a[0], c = this.display(b), d = this.$selection.find(".select2-selection__rendered");
                d.empty().append(c), d.prop("title", b.title || b.text)
            }, d
        }), b.define("select2/selection/multiple", ["jquery", "./base", "../utils"], function(a, b, c){
            function d()
            {
                d.__super__.constructor.apply(this, arguments)
            }

            return c.Extend(d, b), d.prototype.render = function(){
                var a = d.__super__.render.call(this);
                return a.addClass("select2-selection--multiple"), a.html('<ul class="select2-selection__rendered"></ul>'), a
            }, d.prototype.bind = function(){
                var b = this;
                d.__super__.bind.apply(this, arguments), this.$selection.on("click", function(a){
                    b.trigger("toggle", {originalEvent: a})
                }), this.$selection.on("click", ".select2-selection__choice__remove", function(c){
                    var d = a(this), e = d.parent(), f = e.data("data");
                    b.trigger("unselect", {originalEvent: c, data: f})
                })
            }, d.prototype.clear = function(){
                this.$selection.find(".select2-selection__rendered").empty()
            }, d.prototype.display = function(a){
                var b = this.options.get("templateSelection"), c = this.options.get("escapeMarkup");
                return c(b(a))
            }, d.prototype.selectionContainer = function(){
                var b = a('<li class="select2-selection__choice"><span class="select2-selection__choice__remove" role="presentation">&times;</span></li>');
                return b
            }, d.prototype.update = function(b){
                if(this.clear(), 0 !== b.length)
                {
                    for(var c = a(), d = 0 ; d < b.length ; d++)
                    {
                        var e = b[d], f = this.display(e), g = this.selectionContainer();
                        g.append(f), g.prop("title", e.title || e.text), g.data("data", e), c = c.add(g)
                    }
                    this.$selection.find(".select2-selection__rendered").append(c)
                }
            }, d
        }), b.define("select2/selection/placeholder", ["../utils"], function(){
            function a(a, b, c)
            {
                this.placeholder = this.normalizePlaceholder(c.get("placeholder")), a.call(this, b, c)
            }

            return a.prototype.normalizePlaceholder = function(a, b){
                return "string" == typeof b && (b = {id: "", text: b}), b
            }, a.prototype.createPlaceholder = function(a, b){
                var c = this.selectionContainer();
                return c.html(this.display(b)), c.addClass("select2-selection__placeholder").removeClass("select2-selection__choice"), c
            }, a.prototype.update = function(a, b){
                var c = 1 == b.length && b[0].id != this.placeholder.id, d = b.length > 1;
                if(d || c) return a.call(this, b);
                this.clear();
                var e = this.createPlaceholder(this.placeholder);
                this.$selection.find(".select2-selection__rendered").append(e)
            }, a
        }), b.define("select2/selection/allowClear", ["jquery"], function(a){
            function b()
            {
            }

            return b.prototype.bind = function(b, c, d){
                var e = this;
                b.call(this, c, d), null == e.placeholder && e.options.get("debug") && window.console && console.error && console.error("Select2: The `allowClear` option should be used in combination with the `placeholder` option."), this.$selection.on("mousedown", ".select2-selection__clear", function(b){
                    if(!e.options.get("disabled"))
                    {
                        b.stopPropagation();
                        for(var c = a(this).data("data"), d = 0 ; d < c.length ; d++)
                        {
                            var f = {data: c[d]};
                            if(e.trigger("unselect", f), f.prevented) return
                        }
                        e.$element.val(e.placeholder.id).trigger("change"), e.trigger("toggle")
                    }
                })
            }, b.prototype.update = function(b, c){
                if(b.call(this, c), !(this.$selection.find(".select2-selection__placeholder").length > 0 || 0 === c.length))
                {
                    var d = a('<span class="select2-selection__clear">&times;</span>');
                    d.data("data", c), this.$selection.find(".select2-selection__rendered").prepend(d)
                }
            }, b
        }), b.define("select2/selection/search", ["jquery", "../utils", "../keys"], function(a, b, c){
            function d(a, b, c)
            {
                a.call(this, b, c)
            }

            return d.prototype.render = function(b){
                var c = a('<li class="select2-search select2-search--inline"><input class="select2-search__field" type="search" tabindex="-1" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" role="textbox" /></li>');
                this.$searchContainer = c, this.$search = c.find("input");
                var d = b.call(this);
                return d
            }, d.prototype.bind = function(a, b, d){
                var e = this;
                a.call(this, b, d), b.on("open", function(){
                    e.$search.attr("tabindex", 0), e.$search.focus()
                }), b.on("close", function(){
                    e.$search.attr("tabindex", -1), e.$search.val(""), e.$search.focus()
                }), b.on("enable", function(){
                    e.$search.prop("disabled", !1)
                }), b.on("disable", function(){
                    e.$search.prop("disabled", !0)
                }), this.$selection.on("focusin", ".select2-search--inline", function(a){
                    e.trigger("focus", a)
                }), this.$selection.on("focusout", ".select2-search--inline", function(a){
                    e.trigger("blur", a)
                }), this.$selection.on("keydown", ".select2-search--inline", function(a){
                    a.stopPropagation(), e.trigger("keypress", a), e._keyUpPrevented = a.isDefaultPrevented();
                    var b = a.which;
                    if(b === c.BACKSPACE && "" === e.$search.val())
                    {
                        var d = e.$searchContainer.prev(".select2-selection__choice");
                        if(d.length > 0)
                        {
                            var f = d.data("data");
                            e.searchRemoveChoice(f)
                        }
                    }
                }), this.$selection.on("input", ".select2-search--inline", function(){
                    e.$selection.off("keyup.search")
                }), this.$selection.on("keyup.search input", ".select2-search--inline", function(a){
                    e.handleSearch(a)
                })
            }, d.prototype.createPlaceholder = function(a, b){
                this.$search.attr("placeholder", b.text)
            }, d.prototype.update = function(a, b){
                this.$search.attr("placeholder", ""), a.call(this, b), this.$selection.find(".select2-selection__rendered").append(this.$searchContainer), this.resizeSearch()
            }, d.prototype.handleSearch = function(){
                if(this.resizeSearch(), !this._keyUpPrevented)
                {
                    var a = this.$search.val();
                    this.trigger("query", {term: a})
                }
                this._keyUpPrevented = !1
            }, d.prototype.searchRemoveChoice = function(a, b){
                this.trigger("unselect", {data: b}), this.trigger("open"), this.$search.val(b.text + " ")
            }, d.prototype.resizeSearch = function(){
                this.$search.css("width", "25px");
                var a = "";
                if("" !== this.$search.attr("placeholder")) a = this.$selection.find(".select2-selection__rendered").innerWidth();
                else
                {
                    var b = this.$search.val().length + 1;
                    a = .75 * b + "em"
                }
                this.$search.css("width", a)
            }, d
        }), b.define("select2/selection/eventRelay", ["jquery"], function(a){
            function b()
            {
            }

            return b.prototype.bind = function(b, c, d){
                var e = this,
                    f = ["open", "opening", "close", "closing", "select", "selecting", "unselect", "unselecting"],
                    g = ["opening", "closing", "selecting", "unselecting"];
                b.call(this, c, d), c.on("*", function(b, c){
                    if(-1 !== a.inArray(b, f))
                    {
                        c = c || {};
                        var d = a.Event("select2:" + b, {params: c});
                        e.$element.trigger(d), -1 !== a.inArray(b, g) && (c.prevented = d.isDefaultPrevented())
                    }
                })
            }, b
        }), b.define("select2/translation", ["jquery", "require"], function(a, b){
            function c(a)
            {
                this.dict = a || {}
            }

            return c.prototype.all = function(){
                return this.dict
            }, c.prototype.get = function(a){
                return this.dict[a]
            }, c.prototype.extend = function(b){
                this.dict = a.extend({}, b.all(), this.dict)
            }, c._cache = {}, c.loadPath = function(a){
                if(!(a in c._cache))
                {
                    var d = b(a);
                    c._cache[a] = d
                }
                return new c(c._cache[a])
            }, c
        }), b.define("select2/diacritics", [], function(){
            var a = {
                "Ⓐ": "A",
                "Ａ": "A",
                "À": "A",
                "Á": "A",
                "Â": "A",
                "Ầ": "A",
                "Ấ": "A",
                "Ẫ": "A",
                "Ẩ": "A",
                "Ã": "A",
                "Ā": "A",
                "Ă": "A",
                "Ằ": "A",
                "Ắ": "A",
                "Ẵ": "A",
                "Ẳ": "A",
                "Ȧ": "A",
                "Ǡ": "A",
                "Ä": "A",
                "Ǟ": "A",
                "Ả": "A",
                "Å": "A",
                "Ǻ": "A",
                "Ǎ": "A",
                "Ȁ": "A",
                "Ȃ": "A",
                "Ạ": "A",
                "Ậ": "A",
                "Ặ": "A",
                "Ḁ": "A",
                "Ą": "A",
                "Ⱥ": "A",
                "Ɐ": "A",
                "Ꜳ": "AA",
                "Æ": "AE",
                "Ǽ": "AE",
                "Ǣ": "AE",
                "Ꜵ": "AO",
                "Ꜷ": "AU",
                "Ꜹ": "AV",
                "Ꜻ": "AV",
                "Ꜽ": "AY",
                "Ⓑ": "B",
                "Ｂ": "B",
                "Ḃ": "B",
                "Ḅ": "B",
                "Ḇ": "B",
                "Ƀ": "B",
                "Ƃ": "B",
                "Ɓ": "B",
                "Ⓒ": "C",
                "Ｃ": "C",
                "Ć": "C",
                "Ĉ": "C",
                "Ċ": "C",
                "Č": "C",
                "Ç": "C",
                "Ḉ": "C",
                "Ƈ": "C",
                "Ȼ": "C",
                "Ꜿ": "C",
                "Ⓓ": "D",
                "Ｄ": "D",
                "Ḋ": "D",
                "Ď": "D",
                "Ḍ": "D",
                "Ḑ": "D",
                "Ḓ": "D",
                "Ḏ": "D",
                "Đ": "D",
                "Ƌ": "D",
                "Ɗ": "D",
                "Ɖ": "D",
                "Ꝺ": "D",
                "Ǳ": "DZ",
                "Ǆ": "DZ",
                "ǲ": "Dz",
                "ǅ": "Dz",
                "Ⓔ": "E",
                "Ｅ": "E",
                "È": "E",
                "É": "E",
                "Ê": "E",
                "Ề": "E",
                "Ế": "E",
                "Ễ": "E",
                "Ể": "E",
                "Ẽ": "E",
                "Ē": "E",
                "Ḕ": "E",
                "Ḗ": "E",
                "Ĕ": "E",
                "Ė": "E",
                "Ë": "E",
                "Ẻ": "E",
                "Ě": "E",
                "Ȅ": "E",
                "Ȇ": "E",
                "Ẹ": "E",
                "Ệ": "E",
                "Ȩ": "E",
                "Ḝ": "E",
                "Ę": "E",
                "Ḙ": "E",
                "Ḛ": "E",
                "Ɛ": "E",
                "Ǝ": "E",
                "Ⓕ": "F",
                "Ｆ": "F",
                "Ḟ": "F",
                "Ƒ": "F",
                "Ꝼ": "F",
                "Ⓖ": "G",
                "Ｇ": "G",
                "Ǵ": "G",
                "Ĝ": "G",
                "Ḡ": "G",
                "Ğ": "G",
                "Ġ": "G",
                "Ǧ": "G",
                "Ģ": "G",
                "Ǥ": "G",
                "Ɠ": "G",
                "Ꞡ": "G",
                "Ᵹ": "G",
                "Ꝿ": "G",
                "Ⓗ": "H",
                "Ｈ": "H",
                "Ĥ": "H",
                "Ḣ": "H",
                "Ḧ": "H",
                "Ȟ": "H",
                "Ḥ": "H",
                "Ḩ": "H",
                "Ḫ": "H",
                "Ħ": "H",
                "Ⱨ": "H",
                "Ⱶ": "H",
                "Ɥ": "H",
                "Ⓘ": "I",
                "Ｉ": "I",
                "Ì": "I",
                "Í": "I",
                "Î": "I",
                "Ĩ": "I",
                "Ī": "I",
                "Ĭ": "I",
                "İ": "I",
                "Ï": "I",
                "Ḯ": "I",
                "Ỉ": "I",
                "Ǐ": "I",
                "Ȉ": "I",
                "Ȋ": "I",
                "Ị": "I",
                "Į": "I",
                "Ḭ": "I",
                "Ɨ": "I",
                "Ⓙ": "J",
                "Ｊ": "J",
                "Ĵ": "J",
                "Ɉ": "J",
                "Ⓚ": "K",
                "Ｋ": "K",
                "Ḱ": "K",
                "Ǩ": "K",
                "Ḳ": "K",
                "Ķ": "K",
                "Ḵ": "K",
                "Ƙ": "K",
                "Ⱪ": "K",
                "Ꝁ": "K",
                "Ꝃ": "K",
                "Ꝅ": "K",
                "Ꞣ": "K",
                "Ⓛ": "L",
                "Ｌ": "L",
                "Ŀ": "L",
                "Ĺ": "L",
                "Ľ": "L",
                "Ḷ": "L",
                "Ḹ": "L",
                "Ļ": "L",
                "Ḽ": "L",
                "Ḻ": "L",
                "Ł": "L",
                "Ƚ": "L",
                "Ɫ": "L",
                "Ⱡ": "L",
                "Ꝉ": "L",
                "Ꝇ": "L",
                "Ꞁ": "L",
                "Ǉ": "LJ",
                "ǈ": "Lj",
                "Ⓜ": "M",
                "Ｍ": "M",
                "Ḿ": "M",
                "Ṁ": "M",
                "Ṃ": "M",
                "Ɱ": "M",
                "Ɯ": "M",
                "Ⓝ": "N",
                "Ｎ": "N",
                "Ǹ": "N",
                "Ń": "N",
                "Ñ": "N",
                "Ṅ": "N",
                "Ň": "N",
                "Ṇ": "N",
                "Ņ": "N",
                "Ṋ": "N",
                "Ṉ": "N",
                "Ƞ": "N",
                "Ɲ": "N",
                "Ꞑ": "N",
                "Ꞥ": "N",
                "Ǌ": "NJ",
                "ǋ": "Nj",
                "Ⓞ": "O",
                "Ｏ": "O",
                "Ò": "O",
                "Ó": "O",
                "Ô": "O",
                "Ồ": "O",
                "Ố": "O",
                "Ỗ": "O",
                "Ổ": "O",
                "Õ": "O",
                "Ṍ": "O",
                "Ȭ": "O",
                "Ṏ": "O",
                "Ō": "O",
                "Ṑ": "O",
                "Ṓ": "O",
                "Ŏ": "O",
                "Ȯ": "O",
                "Ȱ": "O",
                "Ö": "O",
                "Ȫ": "O",
                "Ỏ": "O",
                "Ő": "O",
                "Ǒ": "O",
                "Ȍ": "O",
                "Ȏ": "O",
                "Ơ": "O",
                "Ờ": "O",
                "Ớ": "O",
                "Ỡ": "O",
                "Ở": "O",
                "Ợ": "O",
                "Ọ": "O",
                "Ộ": "O",
                "Ǫ": "O",
                "Ǭ": "O",
                "Ø": "O",
                "Ǿ": "O",
                "Ɔ": "O",
                "Ɵ": "O",
                "Ꝋ": "O",
                "Ꝍ": "O",
                "Ƣ": "OI",
                "Ꝏ": "OO",
                "Ȣ": "OU",
                "Ⓟ": "P",
                "Ｐ": "P",
                "Ṕ": "P",
                "Ṗ": "P",
                "Ƥ": "P",
                "Ᵽ": "P",
                "Ꝑ": "P",
                "Ꝓ": "P",
                "Ꝕ": "P",
                "Ⓠ": "Q",
                "Ｑ": "Q",
                "Ꝗ": "Q",
                "Ꝙ": "Q",
                "Ɋ": "Q",
                "Ⓡ": "R",
                "Ｒ": "R",
                "Ŕ": "R",
                "Ṙ": "R",
                "Ř": "R",
                "Ȑ": "R",
                "Ȓ": "R",
                "Ṛ": "R",
                "Ṝ": "R",
                "Ŗ": "R",
                "Ṟ": "R",
                "Ɍ": "R",
                "Ɽ": "R",
                "Ꝛ": "R",
                "Ꞧ": "R",
                "Ꞃ": "R",
                "Ⓢ": "S",
                "Ｓ": "S",
                "ẞ": "S",
                "Ś": "S",
                "Ṥ": "S",
                "Ŝ": "S",
                "Ṡ": "S",
                "Š": "S",
                "Ṧ": "S",
                "Ṣ": "S",
                "Ṩ": "S",
                "Ș": "S",
                "Ş": "S",
                "Ȿ": "S",
                "Ꞩ": "S",
                "Ꞅ": "S",
                "Ⓣ": "T",
                "Ｔ": "T",
                "Ṫ": "T",
                "Ť": "T",
                "Ṭ": "T",
                "Ț": "T",
                "Ţ": "T",
                "Ṱ": "T",
                "Ṯ": "T",
                "Ŧ": "T",
                "Ƭ": "T",
                "Ʈ": "T",
                "Ⱦ": "T",
                "Ꞇ": "T",
                "Ꜩ": "TZ",
                "Ⓤ": "U",
                "Ｕ": "U",
                "Ù": "U",
                "Ú": "U",
                "Û": "U",
                "Ũ": "U",
                "Ṹ": "U",
                "Ū": "U",
                "Ṻ": "U",
                "Ŭ": "U",
                "Ü": "U",
                "Ǜ": "U",
                "Ǘ": "U",
                "Ǖ": "U",
                "Ǚ": "U",
                "Ủ": "U",
                "Ů": "U",
                "Ű": "U",
                "Ǔ": "U",
                "Ȕ": "U",
                "Ȗ": "U",
                "Ư": "U",
                "Ừ": "U",
                "Ứ": "U",
                "Ữ": "U",
                "Ử": "U",
                "Ự": "U",
                "Ụ": "U",
                "Ṳ": "U",
                "Ų": "U",
                "Ṷ": "U",
                "Ṵ": "U",
                "Ʉ": "U",
                "Ⓥ": "V",
                "Ｖ": "V",
                "Ṽ": "V",
                "Ṿ": "V",
                "Ʋ": "V",
                "Ꝟ": "V",
                "Ʌ": "V",
                "Ꝡ": "VY",
                "Ⓦ": "W",
                "Ｗ": "W",
                "Ẁ": "W",
                "Ẃ": "W",
                "Ŵ": "W",
                "Ẇ": "W",
                "Ẅ": "W",
                "Ẉ": "W",
                "Ⱳ": "W",
                "Ⓧ": "X",
                "Ｘ": "X",
                "Ẋ": "X",
                "Ẍ": "X",
                "Ⓨ": "Y",
                "Ｙ": "Y",
                "Ỳ": "Y",
                "Ý": "Y",
                "Ŷ": "Y",
                "Ỹ": "Y",
                "Ȳ": "Y",
                "Ẏ": "Y",
                "Ÿ": "Y",
                "Ỷ": "Y",
                "Ỵ": "Y",
                "Ƴ": "Y",
                "Ɏ": "Y",
                "Ỿ": "Y",
                "Ⓩ": "Z",
                "Ｚ": "Z",
                "Ź": "Z",
                "Ẑ": "Z",
                "Ż": "Z",
                "Ž": "Z",
                "Ẓ": "Z",
                "Ẕ": "Z",
                "Ƶ": "Z",
                "Ȥ": "Z",
                "Ɀ": "Z",
                "Ⱬ": "Z",
                "Ꝣ": "Z",
                "ⓐ": "a",
                "ａ": "a",
                "ẚ": "a",
                "à": "a",
                "á": "a",
                "â": "a",
                "ầ": "a",
                "ấ": "a",
                "ẫ": "a",
                "ẩ": "a",
                "ã": "a",
                "ā": "a",
                "ă": "a",
                "ằ": "a",
                "ắ": "a",
                "ẵ": "a",
                "ẳ": "a",
                "ȧ": "a",
                "ǡ": "a",
                "ä": "a",
                "ǟ": "a",
                "ả": "a",
                "å": "a",
                "ǻ": "a",
                "ǎ": "a",
                "ȁ": "a",
                "ȃ": "a",
                "ạ": "a",
                "ậ": "a",
                "ặ": "a",
                "ḁ": "a",
                "ą": "a",
                "ⱥ": "a",
                "ɐ": "a",
                "ꜳ": "aa",
                "æ": "ae",
                "ǽ": "ae",
                "ǣ": "ae",
                "ꜵ": "ao",
                "ꜷ": "au",
                "ꜹ": "av",
                "ꜻ": "av",
                "ꜽ": "ay",
                "ⓑ": "b",
                "ｂ": "b",
                "ḃ": "b",
                "ḅ": "b",
                "ḇ": "b",
                "ƀ": "b",
                "ƃ": "b",
                "ɓ": "b",
                "ⓒ": "c",
                "ｃ": "c",
                "ć": "c",
                "ĉ": "c",
                "ċ": "c",
                "č": "c",
                "ç": "c",
                "ḉ": "c",
                "ƈ": "c",
                "ȼ": "c",
                "ꜿ": "c",
                "ↄ": "c",
                "ⓓ": "d",
                "ｄ": "d",
                "ḋ": "d",
                "ď": "d",
                "ḍ": "d",
                "ḑ": "d",
                "ḓ": "d",
                "ḏ": "d",
                "đ": "d",
                "ƌ": "d",
                "ɖ": "d",
                "ɗ": "d",
                "ꝺ": "d",
                "ǳ": "dz",
                "ǆ": "dz",
                "ⓔ": "e",
                "ｅ": "e",
                "è": "e",
                "é": "e",
                "ê": "e",
                "ề": "e",
                "ế": "e",
                "ễ": "e",
                "ể": "e",
                "ẽ": "e",
                "ē": "e",
                "ḕ": "e",
                "ḗ": "e",
                "ĕ": "e",
                "ė": "e",
                "ë": "e",
                "ẻ": "e",
                "ě": "e",
                "ȅ": "e",
                "ȇ": "e",
                "ẹ": "e",
                "ệ": "e",
                "ȩ": "e",
                "ḝ": "e",
                "ę": "e",
                "ḙ": "e",
                "ḛ": "e",
                "ɇ": "e",
                "ɛ": "e",
                "ǝ": "e",
                "ⓕ": "f",
                "ｆ": "f",
                "ḟ": "f",
                "ƒ": "f",
                "ꝼ": "f",
                "ⓖ": "g",
                "ｇ": "g",
                "ǵ": "g",
                "ĝ": "g",
                "ḡ": "g",
                "ğ": "g",
                "ġ": "g",
                "ǧ": "g",
                "ģ": "g",
                "ǥ": "g",
                "ɠ": "g",
                "ꞡ": "g",
                "ᵹ": "g",
                "ꝿ": "g",
                "ⓗ": "h",
                "ｈ": "h",
                "ĥ": "h",
                "ḣ": "h",
                "ḧ": "h",
                "ȟ": "h",
                "ḥ": "h",
                "ḩ": "h",
                "ḫ": "h",
                "ẖ": "h",
                "ħ": "h",
                "ⱨ": "h",
                "ⱶ": "h",
                "ɥ": "h",
                "ƕ": "hv",
                "ⓘ": "i",
                "ｉ": "i",
                "ì": "i",
                "í": "i",
                "î": "i",
                "ĩ": "i",
                "ī": "i",
                "ĭ": "i",
                "ï": "i",
                "ḯ": "i",
                "ỉ": "i",
                "ǐ": "i",
                "ȉ": "i",
                "ȋ": "i",
                "ị": "i",
                "į": "i",
                "ḭ": "i",
                "ɨ": "i",
                "ı": "i",
                "ⓙ": "j",
                "ｊ": "j",
                "ĵ": "j",
                "ǰ": "j",
                "ɉ": "j",
                "ⓚ": "k",
                "ｋ": "k",
                "ḱ": "k",
                "ǩ": "k",
                "ḳ": "k",
                "ķ": "k",
                "ḵ": "k",
                "ƙ": "k",
                "ⱪ": "k",
                "ꝁ": "k",
                "ꝃ": "k",
                "ꝅ": "k",
                "ꞣ": "k",
                "ⓛ": "l",
                "ｌ": "l",
                "ŀ": "l",
                "ĺ": "l",
                "ľ": "l",
                "ḷ": "l",
                "ḹ": "l",
                "ļ": "l",
                "ḽ": "l",
                "ḻ": "l",
                "ſ": "l",
                "ł": "l",
                "ƚ": "l",
                "ɫ": "l",
                "ⱡ": "l",
                "ꝉ": "l",
                "ꞁ": "l",
                "ꝇ": "l",
                "ǉ": "lj",
                "ⓜ": "m",
                "ｍ": "m",
                "ḿ": "m",
                "ṁ": "m",
                "ṃ": "m",
                "ɱ": "m",
                "ɯ": "m",
                "ⓝ": "n",
                "ｎ": "n",
                "ǹ": "n",
                "ń": "n",
                "ñ": "n",
                "ṅ": "n",
                "ň": "n",
                "ṇ": "n",
                "ņ": "n",
                "ṋ": "n",
                "ṉ": "n",
                "ƞ": "n",
                "ɲ": "n",
                "ŉ": "n",
                "ꞑ": "n",
                "ꞥ": "n",
                "ǌ": "nj",
                "ⓞ": "o",
                "ｏ": "o",
                "ò": "o",
                "ó": "o",
                "ô": "o",
                "ồ": "o",
                "ố": "o",
                "ỗ": "o",
                "ổ": "o",
                "õ": "o",
                "ṍ": "o",
                "ȭ": "o",
                "ṏ": "o",
                "ō": "o",
                "ṑ": "o",
                "ṓ": "o",
                "ŏ": "o",
                "ȯ": "o",
                "ȱ": "o",
                "ö": "o",
                "ȫ": "o",
                "ỏ": "o",
                "ő": "o",
                "ǒ": "o",
                "ȍ": "o",
                "ȏ": "o",
                "ơ": "o",
                "ờ": "o",
                "ớ": "o",
                "ỡ": "o",
                "ở": "o",
                "ợ": "o",
                "ọ": "o",
                "ộ": "o",
                "ǫ": "o",
                "ǭ": "o",
                "ø": "o",
                "ǿ": "o",
                "ɔ": "o",
                "ꝋ": "o",
                "ꝍ": "o",
                "ɵ": "o",
                "ƣ": "oi",
                "ȣ": "ou",
                "ꝏ": "oo",
                "ⓟ": "p",
                "ｐ": "p",
                "ṕ": "p",
                "ṗ": "p",
                "ƥ": "p",
                "ᵽ": "p",
                "ꝑ": "p",
                "ꝓ": "p",
                "ꝕ": "p",
                "ⓠ": "q",
                "ｑ": "q",
                "ɋ": "q",
                "ꝗ": "q",
                "ꝙ": "q",
                "ⓡ": "r",
                "ｒ": "r",
                "ŕ": "r",
                "ṙ": "r",
                "ř": "r",
                "ȑ": "r",
                "ȓ": "r",
                "ṛ": "r",
                "ṝ": "r",
                "ŗ": "r",
                "ṟ": "r",
                "ɍ": "r",
                "ɽ": "r",
                "ꝛ": "r",
                "ꞧ": "r",
                "ꞃ": "r",
                "ⓢ": "s",
                "ｓ": "s",
                "ß": "s",
                "ś": "s",
                "ṥ": "s",
                "ŝ": "s",
                "ṡ": "s",
                "š": "s",
                "ṧ": "s",
                "ṣ": "s",
                "ṩ": "s",
                "ș": "s",
                "ş": "s",
                "ȿ": "s",
                "ꞩ": "s",
                "ꞅ": "s",
                "ẛ": "s",
                "ⓣ": "t",
                "ｔ": "t",
                "ṫ": "t",
                "ẗ": "t",
                "ť": "t",
                "ṭ": "t",
                "ț": "t",
                "ţ": "t",
                "ṱ": "t",
                "ṯ": "t",
                "ŧ": "t",
                "ƭ": "t",
                "ʈ": "t",
                "ⱦ": "t",
                "ꞇ": "t",
                "ꜩ": "tz",
                "ⓤ": "u",
                "ｕ": "u",
                "ù": "u",
                "ú": "u",
                "û": "u",
                "ũ": "u",
                "ṹ": "u",
                "ū": "u",
                "ṻ": "u",
                "ŭ": "u",
                "ü": "u",
                "ǜ": "u",
                "ǘ": "u",
                "ǖ": "u",
                "ǚ": "u",
                "ủ": "u",
                "ů": "u",
                "ű": "u",
                "ǔ": "u",
                "ȕ": "u",
                "ȗ": "u",
                "ư": "u",
                "ừ": "u",
                "ứ": "u",
                "ữ": "u",
                "ử": "u",
                "ự": "u",
                "ụ": "u",
                "ṳ": "u",
                "ų": "u",
                "ṷ": "u",
                "ṵ": "u",
                "ʉ": "u",
                "ⓥ": "v",
                "ｖ": "v",
                "ṽ": "v",
                "ṿ": "v",
                "ʋ": "v",
                "ꝟ": "v",
                "ʌ": "v",
                "ꝡ": "vy",
                "ⓦ": "w",
                "ｗ": "w",
                "ẁ": "w",
                "ẃ": "w",
                "ŵ": "w",
                "ẇ": "w",
                "ẅ": "w",
                "ẘ": "w",
                "ẉ": "w",
                "ⱳ": "w",
                "ⓧ": "x",
                "ｘ": "x",
                "ẋ": "x",
                "ẍ": "x",
                "ⓨ": "y",
                "ｙ": "y",
                "ỳ": "y",
                "ý": "y",
                "ŷ": "y",
                "ỹ": "y",
                "ȳ": "y",
                "ẏ": "y",
                "ÿ": "y",
                "ỷ": "y",
                "ẙ": "y",
                "ỵ": "y",
                "ƴ": "y",
                "ɏ": "y",
                "ỿ": "y",
                "ⓩ": "z",
                "ｚ": "z",
                "ź": "z",
                "ẑ": "z",
                "ż": "z",
                "ž": "z",
                "ẓ": "z",
                "ẕ": "z",
                "ƶ": "z",
                "ȥ": "z",
                "ɀ": "z",
                "ⱬ": "z",
                "ꝣ": "z",
                "Ά": "Α",
                "Έ": "Ε",
                "Ή": "Η",
                "Ί": "Ι",
                "Ϊ": "Ι",
                "Ό": "Ο",
                "Ύ": "Υ",
                "Ϋ": "Υ",
                "Ώ": "Ω",
                "ά": "α",
                "έ": "ε",
                "ή": "η",
                "ί": "ι",
                "ϊ": "ι",
                "ΐ": "ι",
                "ό": "ο",
                "ύ": "υ",
                "ϋ": "υ",
                "ΰ": "υ",
                "ω": "ω",
                "ς": "σ"
            };
            return a
        }), b.define("select2/data/base", ["../utils"], function(a){
            function b()
            {
                b.__super__.constructor.call(this)
            }

            return a.Extend(b, a.Observable), b.prototype.current = function(){
                throw new Error("The `current` method must be defined in child classes.")
            }, b.prototype.query = function(){
                throw new Error("The `query` method must be defined in child classes.")
            }, b.prototype.bind = function(){
            }, b.prototype.destroy = function(){
            }, b.prototype.generateResultId = function(b, c){
                var d = b.id + "-result-";
                return d += a.generateChars(4), d += null != c.id? "-" + c.id.toString() : "-" + a.generateChars(4)
            }, b
        }), b.define("select2/data/select", ["./base", "../utils", "jquery"], function(a, b, c){
            function d(a, b)
            {
                this.$element = a, this.options = b, d.__super__.constructor.call(this)
            }

            return b.Extend(d, a), d.prototype.current = function(a){
                var b = [], d = this;
                this.$element.find(":selected").each(function(){
                    var a = c(this), e = d.item(a);
                    b.push(e)
                }), a(b)
            }, d.prototype.select = function(a){
                var b = this;
                if(c(a.element).is("option")) return a.element.selected = !0, void this.$element.trigger("change");
                if(this.$element.prop("multiple")) this.current(function(d){
                    var e = [];
                    a = [a], a.push.apply(a, d);
                    for(var f = 0 ; f < a.length ; f++)
                    {
                        var g = a[f].id;
                        -1 === c.inArray(g, e) && e.push(g)
                    }
                    b.$element.val(e), b.$element.trigger("change")
                });
                else
                {
                    var d = a.id;
                    this.$element.val(d), this.$element.trigger("change")
                }
            }, d.prototype.unselect = function(a){
                var b = this;
                if(this.$element.prop("multiple")) return c(a.element).is("option")? (a.element.selected = !1, void this.$element.trigger("change")) : void this.current(function(d){
                    for(var e = [], f = 0 ; f < d.length ; f++)
                    {
                        var g = d[f].id;
                        g !== a.id && -1 === c.inArray(g, e) && e.push(g)
                    }
                    b.$element.val(e), b.$element.trigger("change")
                })
            }, d.prototype.bind = function(a){
                var b = this;
                this.container = a, a.on("select", function(a){
                    b.select(a.data)
                }), a.on("unselect", function(a){
                    b.unselect(a.data)
                })
            }, d.prototype.destroy = function(){
                this.$element.find("*").each(function(){
                    c.removeData(this, "data")
                })
            }, d.prototype.query = function(a, b){
                var d = [], e = this, f = this.$element.children();
                f.each(function(){
                    var b = c(this);
                    if(b.is("option") || b.is("optgroup"))
                    {
                        var f = e.item(b), g = e.matches(a, f);
                        null !== g && d.push(g)
                    }
                }), b({results: d})
            }, d.prototype.addOptions = function(a){
                this.$element.append(a)
            }, d.prototype.option = function(a){
                var b;
                a.children? (b = document.createElement("optgroup"), b.label = a.text) : (b = document.createElement("option"), void 0 !== b.textContent? b.textContent = a.text : b.innerText = a.text), a.id && (b.value = a.id), a.disabled && (b.disabled = !0), a.selected && (b.selected = !0), a.title && (b.title = a.title);
                var d = c(b), e = this._normalizeItem(a);
                return e.element = b, c.data(b, "data", e), d
            }, d.prototype.item = function(a){
                var b = {};
                if(b = c.data(a[0], "data"), null != b) return b;
                if(a.is("option")) b = {
                    id      : a.val(),
                    text    : a.text(),
                    disabled: a.prop("disabled"),
                    selected: a.prop("selected"),
                    title   : a.prop("title")
                };
                else if(a.is("optgroup"))
                {
                    b = {text: a.prop("label"), children: [], title: a.prop("title")};
                    for(var d = a.children("option"), e = [], f = 0 ; f < d.length ; f++)
                    {
                        var g = c(d[f]), h = this.item(g);
                        e.push(h)
                    }
                    b.children = e
                }
                return b = this._normalizeItem(b), b.element = a[0], c.data(a[0], "data", b), b
            }, d.prototype._normalizeItem = function(a){
                c.isPlainObject(a) || (a = {id: a, text: a}), a = c.extend({}, {text: ""}, a);
                var b = {selected: !1, disabled: !1};
                return null != a.id && (a.id = a.id.toString()), null != a.text && (a.text = a.text.toString()), null == a._resultId && a.id && null != this.container && (a._resultId = this.generateResultId(this.container, a)), c.extend({}, b, a)
            }, d.prototype.matches = function(a, b){
                var c = this.options.get("matcher");
                return c(a, b)
            }, d
        }), b.define("select2/data/array", ["./select", "../utils", "jquery"], function(a, b, c){
            function d(a, b)
            {
                var c = b.get("data") || [];
                d.__super__.constructor.call(this, a, b), this.addOptions(this.convertToOptions(c))
            }

            return b.Extend(d, a), d.prototype.select = function(a){
                var b = this.$element.find('option[value="' + a.id + '"]');
                0 === b.length && (b = this.option(a), this.addOptions(b)), d.__super__.select.call(this, a)
            }, d.prototype.convertToOptions = function(a){
                function b(a)
                {
                    return function(){
                        return c(this).val() == a.id
                    }
                }

                for(var d = this, e = this.$element.find("option"), f = e.map(function(){
                    return d.item(c(this)).id
                }).get(), g = c(), h = 0 ; h < a.length ; h++)
                {
                    var i = this._normalizeItem(a[h]);
                    if(c.inArray(i.id, f) >= 0)
                    {
                        var j = e.filter(b(i)), k = this.item(j), l = (c.extend(!0, {}, k, i), this.option(k));
                        j.replaceWith(l)
                    }
                    else
                    {
                        var m = this.option(i);
                        if(i.children)
                        {
                            var n = this.convertToOptions(i.children);
                            m.append(n)
                        }
                        g = g.add(m)
                    }
                }
                return g
            }, d
        }), b.define("select2/data/ajax", ["./array", "../utils", "jquery"], function(a, b, c){
            function d(b, c)
            {
                this.ajaxOptions = this._applyDefaults(c.get("ajax")), null != this.ajaxOptions.processResults && (this.processResults = this.ajaxOptions.processResults), a.__super__.constructor.call(this, b, c)
            }

            return b.Extend(d, a), d.prototype._applyDefaults = function(a){
                var b = {
                    data        : function(a){
                        return {q: a.term}
                    }, transport: function(a, b, d){
                        var e = c.ajax(a);
                        return e.then(b), e.fail(d), e
                    }
                };
                return c.extend({}, b, a, !0)
            }, d.prototype.processResults = function(a){
                return a
            }, d.prototype.query = function(a, b){
                function d()
                {
                    var d = f.transport(f, function(d){
                        var f = e.processResults(d, a);
                        e.options.get("debug") && window.console && console.error && (f && f.results && c.isArray(f.results) || console.error("Select2: The AJAX results did not return an array in the `results` key of the response.")), b(f)
                    }, function(){
                    });
                    e._request = d
                }

                var e = this;
                this._request && (this._request.abort(), this._request = null);
                var f = c.extend({type: "GET"}, this.ajaxOptions);
                "function" == typeof f.url && (f.url = f.url(a)), "function" == typeof f.data && (f.data = f.data(a)), this.ajaxOptions.delay && "" !== a.term? (this._queryTimeout && window.clearTimeout(this._queryTimeout), this._queryTimeout = window.setTimeout(d, this.ajaxOptions.delay)) : d()
            }, d
        }), b.define("select2/data/tags", ["jquery"], function(a){
            function b(b, c, d)
            {
                var e = d.get("tags"), f = d.get("createTag");
                if(void 0 !== f && (this.createTag = f), b.call(this, c, d), a.isArray(e)) for(var g = 0 ; g < e.length ; g++)
                {
                    var h = e[g], i = this._normalizeItem(h), j = this.option(i);
                    this.$element.append(j)
                }
            }

            return b.prototype.query = function(a, b, c){
                function d(a, f)
                {
                    for(var g = a.results, h = 0 ; h < g.length ; h++)
                    {
                        var i = g[h], j = null != i.children && !d({results: i.children}, !0), k = i.text === b.term;
                        if(k || j) return f? !1 : (a.data = g, void c(a))
                    }
                    if(f) return !0;
                    var l = e.createTag(b);
                    if(null != l)
                    {
                        var m = e.option(l);
                        m.attr("data-select2-tag", !0), e.addOptions(m), e.insertTag(g, l)
                    }
                    a.results = g, c(a)
                }

                var e = this;
                return this._removeOldTags(), null == b.term || null != b.page? void a.call(this, b, c) : void a.call(this, b, d)
            }, b.prototype.createTag = function(b, c){
                var d = a.trim(c.term);
                return "" === d? null : {id: d, text: d}
            }, b.prototype.insertTag = function(a, b, c){
                b.unshift(c)
            }, b.prototype._removeOldTags = function(){
                var b = (this._lastTag, this.$element.find("option[data-select2-tag]"));
                b.each(function(){
                    this.selected || a(this).remove()
                })
            }, b
        }), b.define("select2/data/tokenizer", ["jquery"], function(a){
            function b(a, b, c)
            {
                var d = c.get("tokenizer");
                void 0 !== d && (this.tokenizer = d), a.call(this, b, c)
            }

            return b.prototype.bind = function(a, b, c){
                a.call(this, b, c), this.$search = b.dropdown.$search || b.selection.$search || c.find(".select2-search__field")
            }, b.prototype.query = function(a, b, c){
                function d(a)
                {
                    e.select(a)
                }

                var e = this;
                b.term = b.term || "";
                var f = this.tokenizer(b, this.options, d);
                f.term !== b.term && (this.$search.length && (this.$search.val(f.term), this.$search.focus()), b.term = f.term), a.call(this, b, c)
            }, b.prototype.tokenizer = function(b, c, d, e){
                for(var f = d.get("tokenSeparators") || [], g = c.term, h = 0, i = this.createTag || function(a){
                    return {id: a.term, text: a.term}
                } ; h < g.length ;)
                {
                    var j = g[h];
                    if(-1 !== a.inArray(j, f))
                    {
                        var k = g.substr(0, h), l = a.extend({}, c, {term: k}), m = i(l);
                        e(m), g = g.substr(h + 1) || "", h = 0
                    }
                    else h++
                }
                return {term: g}
            }, b
        }), b.define("select2/data/minimumInputLength", [], function(){
            function a(a, b, c)
            {
                this.minimumInputLength = c.get("minimumInputLength"), a.call(this, b, c)
            }

            return a.prototype.query = function(a, b, c){
                return b.term = b.term || "", b.term.length < this.minimumInputLength? void this.trigger("results:message", {
                    message: "inputTooShort",
                    args   : {
                        minimum: this.minimumInputLength,
                        input  : b.term,
                        params : b
                    }
                }) : void a.call(this, b, c)
            }, a
        }), b.define("select2/data/maximumInputLength", [], function(){
            function a(a, b, c)
            {
                this.maximumInputLength = c.get("maximumInputLength"), a.call(this, b, c)
            }

            return a.prototype.query = function(a, b, c){
                return b.term = b.term || "", this.maximumInputLength > 0 && b.term.length > this.maximumInputLength? void this.trigger("results:message", {
                    message: "inputTooLong",
                    args   : {
                        maximum: this.maximumInputLength,
                        input  : b.term,
                        params : b
                    }
                }) : void a.call(this, b, c)
            }, a
        }), b.define("select2/data/maximumSelectionLength", [], function(){
            function a(a, b, c)
            {
                this.maximumSelectionLength = c.get("maximumSelectionLength"), a.call(this, b, c)
            }

            return a.prototype.query = function(a, b, c){
                var d = this;
                this.current(function(e){
                    var f = null != e? e.length : 0;
                    return d.maximumSelectionLength > 0 && f >= d.maximumSelectionLength? void d.trigger("results:message", {
                        message: "maximumSelected",
                        args   : {maximum: d.maximumSelectionLength}
                    }) : void a.call(d, b, c)
                })
            }, a
        }), b.define("select2/dropdown", ["jquery", "./utils"], function(a, b){
            function c(a, b)
            {
                this.$element = a, this.options = b, c.__super__.constructor.call(this)
            }

            return b.Extend(c, b.Observable), c.prototype.render = function(){
                var b = a('<span class="select2-dropdown"><span class="select2-results"></span></span>');
                return b.attr("dir", this.options.get("dir")), this.$dropdown = b, b
            }, c.prototype.position = function(){
            }, c.prototype.destroy = function(){
                this.$dropdown.remove()
            }, c
        }), b.define("select2/dropdown/search", ["jquery", "../utils"], function(a){
            function b()
            {
            }

            return b.prototype.render = function(b){
                var c = b.call(this),
                    d = a('<span class="select2-search select2-search--dropdown"><input class="select2-search__field" type="search" tabindex="-1" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" role="textbox" /></span>');
                return this.$searchContainer = d, this.$search = d.find("input"), c.prepend(d), c
            }, b.prototype.bind = function(b, c, d){
                var e = this;
                b.call(this, c, d), this.$search.on("keydown", function(a){
                    e.trigger("keypress", a), e._keyUpPrevented = a.isDefaultPrevented()
                }), this.$search.on("input", function(){
                    a(this).off("keyup")
                }), this.$search.on("keyup input", function(a){
                    e.handleSearch(a)
                }), c.on("open", function(){
                    e.$search.attr("tabindex", 0), e.$search.focus(), window.setTimeout(function(){
                        e.$search.focus()
                    }, 0)
                }), c.on("close", function(){
                    e.$search.attr("tabindex", -1), e.$search.val("")
                }), c.on("results:all", function(a){
                    if(null == a.query.term || "" === a.query.term)
                    {
                        var b = e.showSearch(a);
                        b? e.$searchContainer.removeClass("select2-search--hide") : e.$searchContainer.addClass("select2-search--hide")
                    }
                })
            }, b.prototype.handleSearch = function(){
                if(!this._keyUpPrevented)
                {
                    var a = this.$search.val();
                    this.trigger("query", {term: a})
                }
                this._keyUpPrevented = !1
            }, b.prototype.showSearch = function(){
                return !0
            }, b
        }), b.define("select2/dropdown/hidePlaceholder", [], function(){
            function a(a, b, c, d)
            {
                this.placeholder = this.normalizePlaceholder(c.get("placeholder")), a.call(this, b, c, d)
            }

            return a.prototype.append = function(a, b){
                b.results = this.removePlaceholder(b.results), a.call(this, b)
            }, a.prototype.normalizePlaceholder = function(a, b){
                return "string" == typeof b && (b = {id: "", text: b}), b
            }, a.prototype.removePlaceholder = function(a, b){
                for(var c = b.slice(0), d = b.length - 1 ; d >= 0 ; d--)
                {
                    var e = b[d];
                    this.placeholder.id === e.id && c.splice(d, 1)
                }
                return c
            }, a
        }), b.define("select2/dropdown/infiniteScroll", ["jquery"], function(a){
            function b(a, b, c, d)
            {
                this.lastParams = {}, a.call(this, b, c, d), this.$loadingMore = this.createLoadingMore(), this.loading = !1
            }

            return b.prototype.append = function(a, b){
                this.$loadingMore.remove(), this.loading = !1, a.call(this, b), this.showLoadingMore(b) && this.$results.append(this.$loadingMore)
            }, b.prototype.bind = function(b, c, d){
                var e = this;
                b.call(this, c, d), c.on("query", function(a){
                    e.lastParams = a, e.loading = !0
                }), c.on("query:append", function(a){
                    e.lastParams = a, e.loading = !0
                }), this.$results.on("scroll", function(){
                    var b = a.contains(document.documentElement, e.$loadingMore[0]);
                    if(!e.loading && b)
                    {
                        var c = e.$results.offset().top + e.$results.outerHeight(!1),
                            d = e.$loadingMore.offset().top + e.$loadingMore.outerHeight(!1);
                        c + 50 >= d && e.loadMore()
                    }
                })
            }, b.prototype.loadMore = function(){
                this.loading = !0;
                var b = a.extend({}, {page: 1}, this.lastParams);
                b.page++, this.trigger("query:append", b)
            }, b.prototype.showLoadingMore = function(a, b){
                return b.pagination && b.pagination.more
            }, b.prototype.createLoadingMore = function(){
                var b = a('<li class="option load-more" role="treeitem"></li>'),
                    c = this.options.get("translations").get("loadingMore");
                return b.html(c(this.lastParams)), b
            }, b
        }), b.define("select2/dropdown/attachBody", ["jquery", "../utils"], function(a, b){
            function c(a, b, c)
            {
                this.$dropdownParent = c.get("dropdownParent") || document.body, a.call(this, b, c)
            }

            return c.prototype.bind = function(a, b, c){
                var d = this, e = !1;
                a.call(this, b, c), b.on("open", function(){
                    d._showDropdown(), d._attachPositioningHandler(b), e || (e = !0, b.on("results:all", function(){
                        d._positionDropdown(), d._resizeDropdown()
                    }), b.on("results:append", function(){
                        d._positionDropdown(), d._resizeDropdown()
                    }))
                }), b.on("close", function(){
                    d._hideDropdown(), d._detachPositioningHandler(b)
                }), this.$dropdownContainer.on("mousedown", function(a){
                    a.stopPropagation()
                })
            }, c.prototype.position = function(a, b, c){
                b.attr("class", c.attr("class")), b.removeClass("select2"), b.addClass("select2-container--open"), b.css({
                    position: "absolute",
                    top     : -999999
                }), this.$container = c
            }, c.prototype.render = function(b){
                var c = a("<span></span>"), d = b.call(this);
                return c.append(d), this.$dropdownContainer = c, c
            }, c.prototype._hideDropdown = function(){
                this.$dropdownContainer.detach()
            }, c.prototype._attachPositioningHandler = function(c){
                var d = this, e = "scroll.select2." + c.id, f = "resize.select2." + c.id,
                    g = "orientationchange.select2." + c.id, h = this.$container.parents().filter(b.hasScroll);
                h.each(function(){
                    a(this).data("select2-scroll-position", {x: a(this).scrollLeft(), y: a(this).scrollTop()})
                }), h.on(e, function(){
                    var b = a(this).data("select2-scroll-position");
                    a(this).scrollTop(b.y)
                }), a(window).on(e + " " + f + " " + g, function(){
                    d._positionDropdown(), d._resizeDropdown()
                })
            }, c.prototype._detachPositioningHandler = function(c){
                var d = "scroll.select2." + c.id, e = "resize.select2." + c.id, f = "orientationchange.select2." + c.id,
                    g = this.$container.parents().filter(b.hasScroll);
                g.off(d), a(window).off(d + " " + e + " " + f)
            }, c.prototype._positionDropdown = function(){
                var b = a(window), c = this.$dropdown.hasClass("select2-dropdown--above"),
                    d = this.$dropdown.hasClass("select2-dropdown--below"), e = null,
                    f = (this.$container.position(), this.$container.offset());
                f.bottom = f.top + this.$container.outerHeight(!1);
                var g = {height: this.$container.outerHeight(!1)};
                g.top = f.top, g.bottom = f.top + g.height;
                var h = {height: this.$dropdown.outerHeight(!1)},
                    i = {top: b.scrollTop(), bottom: b.scrollTop() + b.height()}, j = i.top < f.top - h.height,
                    k = i.bottom > f.bottom + h.height, l = {left: f.left, top: g.bottom};
                c || d || (e = "below"), k || !j || c? !j && k && c && (e = "below") : e = "above", ("above" == e || c && "below" !== e) && (l.top = g.top - h.height), null != e && (this.$dropdown.removeClass("select2-dropdown--below select2-dropdown--above").addClass("select2-dropdown--" + e), this.$container.removeClass("select2-container--below select2-container--above").addClass("select2-container--" + e)), this.$dropdownContainer.css(l)
            }, c.prototype._resizeDropdown = function(){
                this.$dropdownContainer.width(), this.$dropdown.css({width: this.$container.outerWidth(!1) + "px"})
            }, c.prototype._showDropdown = function(){
                this.$dropdownContainer.appendTo(this.$dropdownParent), this._positionDropdown(), this._resizeDropdown()
            }, c
        }), b.define("select2/dropdown/minimumResultsForSearch", [], function(){
            function a(b)
            {
                for(var c = 0, d = 0 ; d < b.length ; d++)
                {
                    var e = b[d];
                    e.children? c += a(e.children) : c++
                }
                return c
            }

            function b(a, b, c, d)
            {
                this.minimumResultsForSearch = c.get("minimumResultsForSearch"), this.minimumResultsForSearch < 0 && (this.minimumResultsForSearch = 1 / 0), a.call(this, b, c, d)
            }

            return b.prototype.showSearch = function(b, c){
                return a(c.data.results) < this.minimumResultsForSearch? !1 : b.call(this, c)
            }, b
        }), b.define("select2/dropdown/selectOnClose", [], function(){
            function a()
            {
            }

            return a.prototype.bind = function(a, b, c){
                var d = this;
                a.call(this, b, c), b.on("close", function(){
                    d._handleSelectOnClose()
                })
            }, a.prototype._handleSelectOnClose = function(){
                var a = this.getHighlightedResults();
                a.length < 1 || a.trigger("mouseup")
            }, a
        }), b.define("select2/dropdown/closeOnSelect", [], function(){
            function a()
            {
            }

            return a.prototype.bind = function(a, b, c){
                var d = this;
                a.call(this, b, c), b.on("select", function(a){
                    d._selectTriggered(a)
                }), b.on("unselect", function(a){
                    d._selectTriggered(a)
                })
            }, a.prototype._selectTriggered = function(a, b){
                var c = b.originalEvent;
                c && c.ctrlKey || this.trigger("close")
            }, a
        }), b.define("select2/i18n/en", [], function(){
            return {
                errorLoading      : function(){
                    return "The results could not be loaded."
                }, inputTooLong   : function(a){
                    var b = a.input.length - a.maximum, c = "Please delete " + b + " character";
                    return 1 != b && (c += "s"), c
                }, inputTooShort  : function(a){
                    var b = a.minimum - a.input.length, c = "Please enter " + b + " or more characters";
                    return c
                }, loadingMore    : function(){
                    return "Loading more results…"
                }, maximumSelected: function(a){
                    var b = "You can only select " + a.maximum + " item";
                    return 1 != a.maximum && (b += "s"), b
                }, noResults      : function(){
                    return "No results found"
                }, searching      : function(){
                    return "Searching…"
                }
            }
        }), b.define("select2/defaults", ["jquery", "require", "./results", "./selection/single", "./selection/multiple", "./selection/placeholder", "./selection/allowClear", "./selection/search", "./selection/eventRelay", "./utils", "./translation", "./diacritics", "./data/select", "./data/array", "./data/ajax", "./data/tags", "./data/tokenizer", "./data/minimumInputLength", "./data/maximumInputLength", "./data/maximumSelectionLength", "./dropdown", "./dropdown/search", "./dropdown/hidePlaceholder", "./dropdown/infiniteScroll", "./dropdown/attachBody", "./dropdown/minimumResultsForSearch", "./dropdown/selectOnClose", "./dropdown/closeOnSelect", "./i18n/en"], function(a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z, A, B, C){
            function D()
            {
                this.reset()
            }

            D.prototype.apply = function(l){
                if(l = a.extend({}, this.defaults, l), null == l.dataAdapter)
                {
                    if(l.dataAdapter = null != l.ajax? o : null != l.data? n : m, l.minimumInputLength > 0 && (l.dataAdapter = j.Decorate(l.dataAdapter, r)), l.maximumInputLength > 0 && (l.dataAdapter = j.Decorate(l.dataAdapter, s)), l.maximumSelectionLength > 0 && (l.dataAdapter = j.Decorate(l.dataAdapter, t)), l.tags && (l.dataAdapter = j.Decorate(l.dataAdapter, p)), (null != l.tokenSeparators || null != l.tokenizer) && (l.dataAdapter = j.Decorate(l.dataAdapter, q)), null != l.query)
                    {
                        var C = b(l.amdBase + "compat/query");
                        l.dataAdapter = j.Decorate(l.dataAdapter, C)
                    }
                    if(null != l.initSelection)
                    {
                        var D = b(l.amdBase + "compat/initSelection");
                        l.dataAdapter = j.Decorate(l.dataAdapter, D)
                    }
                }
                if(null == l.resultsAdapter && (l.resultsAdapter = c, null != l.ajax && (l.resultsAdapter = j.Decorate(l.resultsAdapter, x)), null != l.placeholder && (l.resultsAdapter = j.Decorate(l.resultsAdapter, w)), l.selectOnClose && (l.resultsAdapter = j.Decorate(l.resultsAdapter, A))), null == l.dropdownAdapter)
                {
                    if(l.multiple) l.dropdownAdapter = u;
                    else
                    {
                        var E = j.Decorate(u, v);
                        l.dropdownAdapter = E
                    }
                    0 !== l.minimumResultsForSearch && (l.dropdownAdapter = j.Decorate(l.dropdownAdapter, z)), l.closeOnSelect && (l.dropdownAdapter = j.Decorate(l.dropdownAdapter, B)), l.dropdownAdapter = j.Decorate(l.dropdownAdapter, y)
                }
                if(null == l.selectionAdapter && (l.selectionAdapter = l.multiple? e : d, null != l.placeholder && (l.selectionAdapter = j.Decorate(l.selectionAdapter, f)), l.allowClear && (l.selectionAdapter = j.Decorate(l.selectionAdapter, g)), l.multiple && (l.selectionAdapter = j.Decorate(l.selectionAdapter, h)), l.selectionAdapter = j.Decorate(l.selectionAdapter, i)), "string" == typeof l.language) if(l.language.indexOf("-") > 0)
                {
                    var F = l.language.split("-"), G = F[0];
                    l.language = [l.language, G]
                }
                else l.language = [l.language];
                if(a.isArray(l.language))
                {
                    var H = new k;
                    l.language.push("en");
                    for(var I = l.language, J = 0 ; J < I.length ; J++)
                    {
                        var K = I[J], L = {};
                        try
                        {
                            L = k.loadPath(K)
                        }
                        catch(M)
                        {
                            try
                            {
                                K = this.defaults.amdLanguageBase + K, L = k.loadPath(K)
                            }
                            catch(N)
                            {
                                l.debug && window.console && console.warn && console.warn('Select2: The language file for "' + K + '" could not be automatically loaded. A fallback will be used instead.');
                                continue
                            }
                        }
                        H.extend(L)
                    }
                    l.translations = H
                }
                else l.translations = new k(l.language);
                return l
            }, D.prototype.reset = function(){
                function b(a)
                {
                    function b(a)
                    {
                        return l[a] || a
                    }

                    return a.replace(/[^\u0000-\u007E]/g, b)
                }

                function c(d, e)
                {
                    if("" === a.trim(d.term)) return e;
                    if(e.children && e.children.length > 0)
                    {
                        for(var f = a.extend(!0, {}, e), g = e.children.length - 1 ; g >= 0 ; g--)
                        {
                            var h = e.children[g], i = c(d, h);
                            null == i && f.children.splice(g, 1)
                        }
                        return f.children.length > 0? f : c(d, f)
                    }
                    var j = b(e.text).toUpperCase(), k = b(d.term).toUpperCase();
                    return j.indexOf(k) > -1? e : null
                }

                this.defaults = {
                    amdBase                : "./",
                    amdLanguageBase        : "./i18n/",
                    closeOnSelect          : !0,
                    debug                  : !1,
                    escapeMarkup           : j.escapeMarkup,
                    language               : C,
                    matcher                : c,
                    minimumInputLength     : 0,
                    maximumInputLength     : 0,
                    maximumSelectionLength : 0,
                    minimumResultsForSearch: 0,
                    selectOnClose          : !1,
                    sorter                 : function(a){
                        return a
                    },
                    templateResult         : function(a){
                        return a.text
                    },
                    templateSelection      : function(a){
                        return a.text
                    },
                    theme                  : "default",
                    width                  : "resolve"
                }
            }, D.prototype.set = function(b, c){
                var d = a.camelCase(b), e = {};
                e[d] = c;
                var f = j._convertData(e);
                a.extend(this.defaults, f)
            };
            var E = new D;
            return E
        }), b.define("select2/options", ["jquery", "./defaults", "./utils"], function(a, b, c){
            function d(a, d)
            {
                if(this.options = a, null != d && this.fromElement(d), this.options = b.apply(this.options), d && d.is("input"))
                {
                    var e = require(this.get("amdBase") + "compat/inputData");
                    this.options.dataAdapter = c.Decorate(this.options.dataAdapter, e)
                }
            }

            return d.prototype.fromElement = function(b){
                var d = ["select2"];
                null == this.options.multiple && (this.options.multiple = b.prop("multiple")), null == this.options.disabled && (this.options.disabled = b.prop("disabled")), null == this.options.language && (b.prop("lang")? this.options.language = b.prop("lang").toLowerCase() : b.closest("[lang]").prop("lang") && (this.options.language = b.closest("[lang]").prop("lang"))), null == this.options.dir && (this.options.dir = b.prop("dir")? b.prop("dir") : b.closest("[dir]").prop("dir")? b.closest("[dir]").prop("dir") : "ltr"), b.prop("disabled", this.options.disabled), b.prop("multiple", this.options.multiple), b.data("select2Tags") && (this.options.debug && window.console && console.warn && console.warn('Select2: The `data-select2-tags` attribute has been changed to use the `data-data` and `data-tags="true"` attributes and will be removed in future versions of Select2.'), b.data("data", b.data("select2Tags")), b.data("tags", !0)), b.data("ajaxUrl") && (this.options.debug && window.console && console.warn && console.warn("Select2: The `data-ajax-url` attribute has been changed to `data-ajax--url` and support for the old attribute will be removed in future versions of Select2."), b.attr("ajax--url", b.data("ajaxUrl")), b.data("ajax--url", b.data("ajaxUrl")));
                var e = {};
                e = a.fn.jquery && "1." == a.fn.jquery.substr(0, 2) && b[0].dataset? a.extend(!0, {}, b[0].dataset, b.data()) : b.data();
                var f = a.extend(!0, {}, e);
                f = c._convertData(f);
                for(var g in f) a.inArray(g, d) > -1 || (a.isPlainObject(this.options[g])? a.extend(this.options[g], f[g]) : this.options[g] = f[g]);
                return this
            }, d.prototype.get = function(a){
                return this.options[a]
            }, d.prototype.set = function(a, b){
                this.options[a] = b
            }, d
        }), b.define("select2/core", ["jquery", "./options", "./utils", "./keys"], function(a, b, c, d){
            var e = function(a, c){
                null != a.data("select2") && a.data("select2").destroy(), this.$element = a, this.id = this._generateId(a), c = c || {}, this.options = new b(c, a), e.__super__.constructor.call(this);
                var d = a.attr("tabindex") || 0;
                a.data("old-tabindex", d), a.attr("tabindex", "-1");
                var f = this.options.get("dataAdapter");
                this.dataAdapter = new f(a, this.options);
                var g = this.render();
                this._placeContainer(g);
                var h = this.options.get("selectionAdapter");
                this.selection = new h(a, this.options), this.$selection = this.selection.render(), this.selection.position(this.$selection, g);
                var i = this.options.get("dropdownAdapter");
                this.dropdown = new i(a, this.options), this.$dropdown = this.dropdown.render(), this.dropdown.position(this.$dropdown, g);
                var j = this.options.get("resultsAdapter");
                this.results = new j(a, this.options, this.dataAdapter), this.$results = this.results.render(), this.results.position(this.$results, this.$dropdown);
                var k = this;
                this._bindAdapters(), this._registerDomEvents(), this._registerDataEvents(), this._registerSelectionEvents(), this._registerDropdownEvents(), this._registerResultsEvents(), this._registerEvents(), this.dataAdapter.current(function(a){
                    k.trigger("selection:update", {data: a})
                }), a.hide(), this._syncAttributes(), a.data("select2", this)
            };
            return c.Extend(e, c.Observable), e.prototype._generateId = function(a){
                var b = "";
                return b = null != a.attr("id")? a.attr("id") : null != a.attr("name")? a.attr("name") + "-" + c.generateChars(2) : c.generateChars(4), b = "select2-" + b
            }, e.prototype._placeContainer = function(a){
                a.insertAfter(this.$element);
                var b = this._resolveWidth(this.$element, this.options.get("width"));
                null != b && a.css("width", b)
            }, e.prototype._resolveWidth = function(a, b){
                var c = /^width:(([-+]?([0-9]*\.)?[0-9]+)(px|em|ex|%|in|cm|mm|pt|pc))/i;
                if("resolve" == b)
                {
                    var d = this._resolveWidth(a, "style");
                    return null != d? d : this._resolveWidth(a, "element")
                }
                if("element" == b)
                {
                    var e = a.outerWidth(!1);
                    return 0 >= e? "auto" : e + "px"
                }
                if("style" == b)
                {
                    var f = a.attr("style");
                    if("string" != typeof f) return null;
                    for(var g = f.split(";"), h = 0, i = g.length ; i > h ; h += 1)
                    {
                        var j = g[h].replace(/\s/g, ""), k = j.match(c);
                        if(null !== k && k.length >= 1) return k[1]
                    }
                    return null
                }
                return b
            }, e.prototype._bindAdapters = function(){
                this.dataAdapter.bind(this, this.$container), this.selection.bind(this, this.$container), this.dropdown.bind(this, this.$container), this.results.bind(this, this.$container)
            }, e.prototype._registerDomEvents = function(){
                var b = this;
                this.$element.on("change.select2", function(){
                    b.dataAdapter.current(function(a){
                        b.trigger("selection:update", {data: a})
                    })
                }), this._sync = c.bind(this._syncAttributes, this), this.$element[0].attachEvent && this.$element[0].attachEvent("onpropertychange", this._sync);
                var d = window.MutationObserver || window.WebKitMutationObserver || window.MozMutationObserver;
                null != d? (this._observer = new d(function(c){
                    a.each(c, b._sync)
                }), this._observer.observe(this.$element[0], {
                    attributes: !0,
                    subtree   : !1
                })) : this.$element[0].addEventListener && this.$element[0].addEventListener("DOMAttrModified", b._sync, !1)
            }, e.prototype._registerDataEvents = function(){
                var a = this;
                this.dataAdapter.on("*", function(b, c){
                    a.trigger(b, c)
                })
            }, e.prototype._registerSelectionEvents = function(){
                var b = this, c = ["toggle"];
                this.selection.on("toggle", function(){
                    b.toggleDropdown()
                }), this.selection.on("*", function(d, e){
                    -1 === a.inArray(d, c) && b.trigger(d, e)
                })
            }, e.prototype._registerDropdownEvents = function(){
                var a = this;
                this.dropdown.on("*", function(b, c){
                    a.trigger(b, c)
                })
            }, e.prototype._registerResultsEvents = function(){
                var a = this;
                this.results.on("*", function(b, c){
                    a.trigger(b, c)
                })
            }, e.prototype._registerEvents = function(){
                var a = this;
                this.on("open", function(){
                    a.$container.addClass("select2-container--open")
                }), this.on("close", function(){
                    a.$container.removeClass("select2-container--open")
                }), this.on("enable", function(){
                    a.$container.removeClass("select2-container--disabled")
                }), this.on("disable", function(){
                    a.$container.addClass("select2-container--disabled")
                }), this.on("focus", function(){
                    a.$container.addClass("select2-container--focus")
                }), this.on("blur", function(){
                    a.$container.removeClass("select2-container--focus")
                }), this.on("query", function(b){
                    a.isOpen() || a.trigger("open"), this.dataAdapter.query(b, function(c){
                        a.trigger("results:all", {data: c, query: b})
                    })
                }), this.on("query:append", function(b){
                    this.dataAdapter.query(b, function(c){
                        a.trigger("results:append", {data: c, query: b})
                    })
                }), this.on("keypress", function(b){
                    var c = b.which;
                    a.isOpen()? c === d.ENTER? (a.trigger("results:select"), b.preventDefault()) : c === d.SPACE && b.ctrlKey? (a.trigger("results:toggle"), b.preventDefault()) : c === d.UP? (a.trigger("results:previous"), b.preventDefault()) : c === d.DOWN? (a.trigger("results:next"), b.preventDefault()) : (c === d.ESC || c === d.TAB) && (a.close(), b.preventDefault()) : (c === d.ENTER || c === d.SPACE || (c === d.DOWN || c === d.UP) && b.altKey) && (a.open(), b.preventDefault())
                })
            }, e.prototype._syncAttributes = function(){
                this.options.set("disabled", this.$element.prop("disabled")), this.options.get("disabled")? (this.isOpen() && this.close(), this.trigger("disable")) : this.trigger("enable")
            }, e.prototype.trigger = function(a, b){
                var c = e.__super__.trigger,
                    d = {open: "opening", close: "closing", select: "selecting", unselect: "unselecting"};
                if(a in d)
                {
                    var f = d[a], g = {prevented: !1, name: a, args: b};
                    if(c.call(this, f, g), g.prevented) return void(b.prevented = !0)
                }
                c.call(this, a, b)
            }, e.prototype.toggleDropdown = function(){
                this.options.get("disabled") || (this.isOpen()? this.close() : this.open())
            }, e.prototype.open = function(){
                this.isOpen() || (this.trigger("query", {}), this.trigger("open"))
            }, e.prototype.close = function(){
                this.isOpen() && this.trigger("close")
            }, e.prototype.isOpen = function(){
                return this.$container.hasClass("select2-container--open")
            }, e.prototype.enable = function(a){
                this.options.get("debug") && window.console && console.warn && console.warn('Select2: The `select2("enable")` method has been deprecated and will be removed in later Select2 versions. Use $element.prop("disabled") instead.'), (null == a || 0 === a.length) && (a = [!0]);
                var b = !a[0];
                this.$element.prop("disabled", b)
            }, e.prototype.data = function(){
                this.options.get("debug") && arguments.length > 0 && window.console && console.warn && console.warn('Select2: Data can no longer be set using `select2("data")`. You should consider setting the value instead using `$element.val()`.');
                var a = [];
                return this.dataAdapter.current(function(b){
                    a = b
                }), a
            }, e.prototype.val = function(b){
                if(this.options.get("debug") && window.console && console.warn && console.warn('Select2: The `select2("val")` method has been deprecated and will be removed in later Select2 versions. Use $element.val() instead.'), null == b || 0 === b.length) return this.$element.val();
                var c = b[0];
                a.isArray(c) && (c = a.map(c, function(a){
                    return a.toString()
                })), this.$element.val(c).trigger("change")
            }, e.prototype.destroy = function(){
                this.$container.remove(), this.$element[0].detachEvent && this.$element[0].detachEvent("onpropertychange", this._sync), null != this._observer? (this._observer.disconnect(), this._observer = null) : this.$element[0].removeEventListener && this.$element[0].removeEventListener("DOMAttrModified", this._sync, !1), this._sync = null, this.$element.off(".select2"), this.$element.attr("tabindex", this.$element.data("old-tabindex")), this.$element.show(), this.$element.removeData("select2"), this.dataAdapter.destroy(), this.selection.destroy(), this.dropdown.destroy(), this.results.destroy(), this.dataAdapter = null, this.selection = null, this.dropdown = null, this.results = null
            }, e.prototype.render = function(){
                var b = a('<span class="select2 select2-container"><span class="selection"></span><span class="dropdown-wrapper" aria-hidden="true"></span></span>');
                return b.attr("dir", this.options.get("dir")), this.$container = b, this.$container.addClass("select2-container--" + this.options.get("theme")), b.data("element", this.$element), b
            }, e
        }), b.define("jquery.select2", ["jquery", "./select2/core", "./select2/defaults"], function(a, b, c){
            try
            {
                require("jquery.mousewheel")
            }
            catch(d)
            {
            }
            return null == a.fn.select2 && (a.fn.select2 = function(c){
                if(c = c || {}, "object" == typeof c) return this.each(function(){
                    {
                        var d = a.extend({}, c, !0);
                        new b(a(this), d)
                    }
                }), this;
                if("string" == typeof c)
                {
                    var d = this.data("select2"), e = Array.prototype.slice.call(arguments, 1);
                    return d[c](e)
                }
                throw new Error("Invalid arguments for Select2: " + c)
            }), null == a.fn.select2.defaults && (a.fn.select2.defaults = c), b
        }), {define: b.define, require: b.require}
    }(), c = b.require("jquery.select2");
    return $.fn.select2.amd = b, c
});

/**
 * Halil
 * Jquery extentions
 */
//This extention is to bind a callback on an event to be called before than other callbacks
$.fn.bindFirst = function(name, fn){
    // bind as you normally would
    // don't want to miss out on any jQuery magic
    this.on(name, fn);

    // Thanks to a comment by @Martin, adding support for
    // namespaced events too.
    this.each(function(){
        var handlers = $._data(this, 'events')[name.split('.')[0]];
        // take out the handler we just inserted from the end
        var handler = handlers.pop();
        // move it at the beginning
        handlers.splice(0, 0, handler);
    });
};

//This extention is to handle mousebutton which is clicked on mouseenter event
$(function(){
    var leftButtonDown = false;
    $(document).mousedown(function(e){
        // Left mouse button was pressed, set flag
        if(e.which === 1) leftButtonDown = true;
    });
    $(document).mouseup(function(e){
        // Left mouse button was released, clear flag
        if(e.which === 1) leftButtonDown = false;
    });

    $.tweakMouseMoveEvent = function(e){
        // Check from jQuery UI for IE versions < 9
        if($.browser.msie && !(document.documentMode >= 9) && !e.button)
        {
            leftButtonDown = false;
        }

        // If left button is not set, set which to 0
        // This indicates no buttons pressed
        if(e.which === 1 && !leftButtonDown) e.which = 0;
    }

    $(document).mousemove(function(e){
        $.tweakMouseMoveEvent(e);
    });
});
/**
 * Halil
 * Jquery extentions - END
 */

var goog = goog || {};

goog.requirelib = function(namespace){
};

window.google = window.google || {};
google.maps = google.maps || {};
(function(){

    function getScript(src)
    {
        document.write('<' + 'script src="' + src + '"><' + '/script>');
    }

    var modules = google.maps.modules = {};
    google.maps.__gjsload__ = function(name, text){
        modules[name] = text;
    };

    google.maps.Load = function(apiLoad){
        delete google.maps.Load;
        apiLoad([0.009999999776482582, [null, [["https://khms0.googleapis.com/kh?v=729\u0026hl=en-US\u0026", "https://khms1.googleapis.com/kh?v=729\u0026hl=en-US\u0026"], null, null, null, 1, "729", ["https://khms0.google.com/kh?v=729\u0026hl=en-US\u0026", "https://khms1.google.com/kh?v=729\u0026hl=en-US\u0026"]], null, null, null, null, [["https://cbks0.googleapis.com/cbk?", "https://cbks1.googleapis.com/cbk?"]], [["https://khms0.googleapis.com/kh?v=106\u0026hl=en-US\u0026", "https://khms1.googleapis.com/kh?v=106\u0026hl=en-US\u0026"], null, null, null, null, "106", ["https://khms0.google.com/kh?v=106\u0026hl=en-US\u0026", "https://khms1.google.com/kh?v=106\u0026hl=en-US\u0026"]], [["https://mts0.googleapis.com/mapslt?hl=en-US\u0026", "https://mts1.googleapis.com/mapslt?hl=en-US\u0026"]], null, null, null, [["https://mts0.googleapis.com/mapslt?hl=en-US\u0026", "https://mts1.googleapis.com/mapslt?hl=en-US\u0026"]]], ["en-US", "US", null, 0, null, null, "https://maps.gstatic.com/mapfiles/", "https://csi.gstatic.com", "https://maps.googleapis.com", "https://maps.googleapis.com", null, "https://maps.google.com", "https://gg.google.com", "https://maps.gstatic.com/maps-api-v3/api/images/", "https://www.google.com/maps", 0, "https://www.google.com"], ["https://maps.googleapis.com/maps-api-v3/api/js/29/12", "3.29.12"], [25689438], 1, null, null, null, null, null, "", ["places"], null, 1, "https://khms.googleapis.com/mz?v=729\u0026", null, "https://earthbuilder.googleapis.com", "https://earthbuilder.googleapis.com", null, "https://mts.googleapis.com/maps/vt/icon", [["https://maps.googleapis.com/maps/vt"], ["https://maps.googleapis.com/maps/vt"], null, null, null, null, null, null, null, null, null, null, ["https://www.google.com/maps/vt"], "/maps/vt", 386000000, 386], 2, 500, [null, null, null, null, "https://www.google.com/maps/preview/log204", "", "https://static.panoramio.com.storage.googleapis.com/photos/", ["https://geo0.ggpht.com/cbk", "https://geo1.ggpht.com/cbk", "https://geo2.ggpht.com/cbk", "https://geo3.ggpht.com/cbk"], "https://maps.googleapis.com/maps/api/js/GeoPhotoService.GetMetadata", "https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch", ["https://lh3.ggpht.com/", "https://lh4.ggpht.com/", "https://lh5.ggpht.com/", "https://lh6.ggpht.com/"]], ["https://www.google.com/maps/api/js/master?pb=!1m2!1u29!2s12!2sen-US!3sUS!4s29/12", "https://www.google.com/maps/api/js/widget?pb=!1m2!1u29!2s12!2sen-US"], null, 0, null, "/maps/api/js/ApplicationService.GetEntityDetails", 0, null, null, [null, null, null, null, null, null, null, null, null, [0, 0]], null, [], ["29.12"]], loadScriptTime);
    };
    var loadScriptTime = (new Date).getTime();
})();
// inlined
